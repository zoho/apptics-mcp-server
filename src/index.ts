#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod";
import { getAppticsClient } from "./appticsConfig";

const server = new McpServer({
  name: "zoho-apptics",
  version: "1.0.0"
});

server.registerTool("get_portals_and_projects_list", {
  description : `List all portals and their projects. 
  Each portal has a name and zsoid (use as portalId). Each project has a name and projectId. 
  Use this to discover valid portalId/projectId before project-scoped queries.`
}, async() => {
  const appticsClient = getAppticsClient();
  const result = await appticsClient.getPortalsAndProjects();
  return {
    content: [{type: 'text', text: JSON.stringify(result)}]
  };
});

server.registerTool("get_crash_list", {
  description: ` Retrieves crash analytics data for your application with flexible filtering and pagination options.  
This tool enables querying crash records across app versions, platforms, and environments within a specified date range.

Use it to analyze crash trends, identify frequent crash types, or segment issues by platform and version.  
By default, the API returns up to 500 production crashes across all platforms and app versions.

The response includes crash identifiers, app version, OS, exception type, crash counts, affected users and devices, and a representative exception message.
  `,
  inputSchema: {
    portalId: z.string().describe("Portal identifier (zsoid) of the portal to which the project belongs."),
    projectId: z.string().describe("Project identifier within the specified portal."),
    startDate: z.string().optional().describe(
        `Inclusive start date for the query in dd-MM-YYYY format. Default: 7 days before today (excluding today).`
      ),
    endDate: z.string().optional().describe(
        `Inclusive end date for the query in dd-MM-YYYY format. Default: yesterday (today is excluded).`
      ),
    appVersion: z.string().optional().describe(
      `Optional comma-separated list of app versions to filter by.
Example: "3.0,3.1,4.0".
Defaults to all versions when omitted.`
      ),
    platform: z.string().optional().describe(
      `Optional comma-separated list of platforms to filter by.
Examples: "iOS,Android", "Windows,tvOS,watchOS,macOS".
Defaults to all supported platforms when omitted.`
      ),
      mode: z.string().optional().describe(
        `Environment filter. 0 for development, 1 for production. Default - 1 (production)`
      ),
      offset: z.string().optional().describe(
        `Starting position for result pagination (default - 0). Increment by limit value for next page (e.g., 501, 1001).`
      ),
      limit: z.string().optional().describe(
        `Number of results per page. Default and maximum: 500. Use smaller values to limit response size.`
      )
  },
  outputSchema: {
    data: z.array(
      z.object({
        AppVersion: z.string(),
        Status: z.number().int(),
        UniqueMessageID: z.string(),
        AppVersionID: z.number().int(),
        PID: z.number().int(),
        ExceptionType: z.string(),
        OS: z.string(),
        CrashCount: z.string(),
        UsersCount: z.string(),
        DevicesCount: z.string(),
        Exception: z.string()
      })
    )
  }
}, async({ portalId, projectId, startDate, endDate, appVersion, platform, mode, offset, limit}) => {
  const appticsClient = getAppticsClient();
  const result = await appticsClient.getCrashList(projectId, portalId, startDate, endDate, appVersion, platform, mode, offset, limit)
  const data = {
    data: (result as { data: [unknown]}).data
  };
  return {
    content: [{type: 'text', text: JSON.stringify(result)}],
    structuredContent: data
  }
});

server.registerTool("get_active_devices", {
   description: `
  Fetch active devices for a specific project. 
  Required: portalId (zsoid) and projectId. Optional: group by "platform", "devicetype", or "appversion"; specify startDate and endDate to filter by date range. 
  Defaults: group="platform"; date range = last 7 days (excluding today).
`,
  inputSchema: {
    portalId: z.string().describe("Portal identifier (zsoid) of the portal to which the project belongs."),
    projectId: z.string().describe("Project identifier within the specified portal."),
    group: z.enum(["platform","devicetype", "appversion"]).optional().describe(`Optional grouping criteria for active devices. Defaults to "platform"`),
    startDate: z.string().optional().describe(
        `Inclusive start date for the query in dd-MM-YYYY format. Default: 7 days before today (excluding today).`
      ),
    endDate: z.string().optional().describe(
        `Inclusive end date for the query in dd-MM-YYYY format. Default: yesterday (today is excluded).`
      ),
  }
}, async({ portalId, projectId, group, startDate, endDate }) => { 
  const appticsClient = getAppticsClient();
  const result = await appticsClient.getActiveDevices(projectId, portalId, startDate, endDate, group);
  return {
    content: [{type: 'text', text: JSON.stringify(result)}]
  };
});

server.registerTool("get_crash_count_by_date", {
  description: `
  Fetch aggregated crash statistics over a specified date range.

The API returns **time-series data** keyed by date (epoch timestamp), platform wise. Time-series data will be keyed by hour of the day, if the data is fetched for single day (same start and end dates)
For each day or each hour, the following metrics are provided:
- **crashcount** - Total number of crashes recorded on that day.
- **issuecount** - Number of **unique issues** (distinct crash signatures) that caused crashes.
- **devicecount** - Number of **unique devices** affected by those crashes.
- **usercount** - Number of **unique users** affected by those crashes.

By default, these data will be provided for all platforms and aggregated for all app versions in the platform.
You can optionally pass one or more platforms and/or app versions as comma-separated lists
to narrow down the results (e.g., \`"iOS,Android"\` or \`"3.0,3.1,4.0"\`).

Supported platforms are iOS, Android, Windows, tvOS, watchOS, macOS. The platforms are case sensitive.

Ideal for **trend analysis** and **crash monitoring dashboards**.`,
  inputSchema: {
    portalId: z.string().describe("Portal identifier (zsoid) of the portal to which the project belongs."),
    projectId: z.string().describe("Project identifier within the specified portal."),
    startDate: z.string().optional().describe(
        `Inclusive start date for the query in dd-MM-YYYY format. Default: 7 days before today (excluding today).`
      ),
    endDate: z.string().optional().describe(
        `Inclusive end date for the query in dd-MM-YYYY format. Default: yesterday (today is excluded).`
      ),
    appVersion: z.string().optional().describe(
      `Optional comma-separated list of app versions to filter by.
Example: "3.0,3.1,4.0".
Defaults to all versions when omitted.`
      ),
    platform: z.string().optional().describe(
      `Optional comma-separated list of platforms to filter by.
Examples: "iOS,Android", "Windows,tvOS,watchOS,macOS".
Defaults to all supported platforms when omitted.`
      )
    },
  }, async({portalId, projectId, startDate, endDate, appVersion, platform}) => {
    const appticsClient = getAppticsClient();
    const data = await appticsClient.getCrashCountByDate(projectId, portalId, startDate, endDate, appVersion, platform)
    return {
      content: [{type: 'text', text: JSON.stringify(data)}]
    }
  });

  server.registerTool("get_crash_detail", {
  description: `
  Retrieves comprehensive details about a specific crash event using its unique identifier (uniqueid).
This tool helps developers and support engineers debug and analyze the root cause of a crash by fetching complete metadata, including:

Exception details (type, message, and stack trace)
Affected screen or activity
Device and OS specifications
Network status and session context
App version, user information, and custom properties

By default, it searches across all app versions, but it can be filtered using an appversion parameter.`,
  inputSchema: {
    portalId: z.string().describe("Portal identifier (zsoid) of the portal to which the project belongs."),
    projectId: z.string().describe("Project identifier within the specified portal."),
    uniqueId: z.string().describe("Unique crash identifier. This can be obtained from the crash list API"),
    startDate: z.string().optional().describe(
        `Inclusive start date for the query in dd-MM-YYYY format. Default: 7 days before today (excluding today).`
      ),
    endDate: z.string().optional().describe(
        `Inclusive end date for the query in dd-MM-YYYY format. Default: yesterday (today is excluded).`
      ),
    appVersion: z.string().optional().describe(
      `Optional comma-separated list of app versions to filter by.
Example: "3.0,3.1,4.0".
Defaults to all versions when omitted.`
      )
    },
  }, async({portalId, projectId, uniqueId, startDate, endDate, appVersion}) => {
    const appticsClient = getAppticsClient();
    const data = await appticsClient.getCrashDetail(projectId, portalId, uniqueId, startDate, endDate, appVersion)
    return {
      content: [{type: 'text', text: JSON.stringify(data)}]
    }
  });

  server.registerTool("get_device_specific_crash_distribution", {
  description: `
  Retrieves crash distribution data grouped by device model for a specific crash.
This endpoint helps identify device-specific crash trends, allowing developers to detect hardware compatibility problems, performance issues, or device-specific bugs.

It requires a unique crash identifier (uniqueid) obtained from the crash list API, and can optionally be filtered by app version.
The response provides a breakdown showing which device models are most affected by the crash and their respective crash counts.

By default, the API analyzes all app versions, with support for pagination (limit and offset) for large datasets.
  `,
  inputSchema: {
    portalId: z.string().describe("Portal identifier (zsoid) of the portal to which the project belongs."),
    projectId: z.string().describe("Project identifier within the specified portal."),
    uniqueId: z.string().describe("Unique crash identifier. This can be obtained from the crash list API"),
    startDate: z.string().optional().describe(
        `Inclusive start date for the query in dd-MM-YYYY format. Default: 7 days before today (excluding today).`
      ),
    endDate: z.string().optional().describe(
        `Inclusive end date for the query in dd-MM-YYYY format. Default: yesterday (today is excluded).`
      ),
    appVersion: z.string().optional().describe(
      `Optional comma-separated list of app versions to filter by.
Example: "3.0,3.1,4.0".
Defaults to all versions when omitted.`
      ),
      offset: z.string().optional().describe(
        `Starting position for result pagination (default - 0). Increment by limit value for next page (e.g., 501, 1001).`
      ),
      limit: z.string().optional().describe(
        `Number of results per page. Default and maximum: 500. Use smaller values to limit response size.`
      )
    },
  }, async({portalId, projectId, uniqueId, startDate, endDate, appVersion, limit, offset}) => {
    const appticsClient = getAppticsClient();
    const data = await appticsClient.getDeviceSpecificCrashDistribution(projectId, portalId, uniqueId, startDate, endDate, appVersion, limit, offset)
    return {
      content: [{type: 'text', text: JSON.stringify(data)}]
    }
  });



const transport = new StdioServerTransport();
(async () => {
  await server.connect(transport);
})();
