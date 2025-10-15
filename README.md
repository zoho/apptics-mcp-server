# Apptics MCP Server

Model Context Protocol (MCP) server for Zoho Apptics analytics. The package authenticates with Zoho, refreshes OAuth tokens on demand, and exposes tools for querying portals, crash lists, crash trends, and active device data from Apptics.

## Prerequisites
- Node.js 18 or newer.
- Zoho Apptics OAuth credentials: client ID, client secret, and a refresh token with access to Apptics APIs.

## Auth Credentials
To configure Zoho Apptics MCP, you need to provide oauth credentials (client id, client secret and refresh token) as environment variables.

1) Create a new self-client application from [Zoho API Console](https://api-console.zoho.com/).
2) Generate code with ```JProxy.jmobileapi.ALL``` scope.
3) Exchange the code for refresh token using the OAuth token endpoint:
  ```bash
   curl -X POST "https://accounts.zoho.com/oauth/v2/token" \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -d "code=YOUR_SELF_CLIENT_CODE" \
     -d "client_id=YOUR_CLIENT_ID" \
     -d "client_secret=YOUR_CLIENT_SECRET" \
     -d "grant_type=authorization_code"
   ```

   The JSON response include `refresh_token`; supply the refresh token via `APPTICS_REFRESH_TOKEN`.
   For other Zoho data centers, switch `accounts.zoho.com` to `accounts.zoho.eu`, `accounts.zoho.in`, etc.

### Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `APPTICS_CLIENT_ID` | Yes | OAuth client ID created in the Zoho API Console. |
| `APPTICS_CLIENT_SECRET` | Yes | OAuth client secret for the Zoho self-client. |
| `APPTICS_REFRESH_TOKEN` | Yes | Refresh token with `JProxy.jmobileapi.ALL` scope used to obtain access tokens. |
| `APPTICS_SERVER_URI` | No | Override for the Apptics API base URL (defaults to `https://apptics.zoho.com/`). Use regional domains if needed. |
| `APPTICS_ACCOUNTS_URI` | No | Override for the Zoho Accounts OAuth base URL (defaults to `https://accounts.zoho.com/`). Switch to `accounts.zoho.eu`, etc. for other data centers. |

### Claude Desktop Configuration

1. Open Claude Desktop.
2. Navigate to Settings -> Developer -> Edit Config
3. Add the following configuration.
```jsonc
   {
     "mcpServers": {
       "zoho-apptics": {
         "command": "npx",
         "args": ["@zoho_apptics/apptics-mcp"],
         "env": {
           "APPTICS_CLIENT_ID": "your_client_id",
           "APPTICS_CLIENT_SECRET": "your_client_secret",
           "APPTICS_REFRESH_TOKEN": "your_refresh_token"
         }
       }
     }
   }
   ```
4. Restart Claude Desktop App.

### Available Tools

| Tool | Description |
| --- | --- |
| `get_portals_and_projects_list` | Lists accessible portals and their projects for the authenticated user. |
| `get_crash_list` | Retrieves crash records with optional filters for date range, platform, app version, mode, pagination. |
| `get_crash_count_by_date` | Returns aggregated crash statistics keyed by date (hourly when querying a single day). |
| `get_active_devices` | Reports active devices grouped by platform/device type/app version within the requested date range. |
| `get_crash_detail` | Fetches detailed metadata, stack trace, and context for a specific crash using its `uniqueId`. |
| `get_device_specific_crash_distribution` | Breaks down crash impact by device model for the given crash, with optional pagination and app-version filters. |
