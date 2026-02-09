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
| `fetch_apptics_config_by_bundle_id` | Fetches Apptics configuration (apptics-config.plist content) for a given iOS bundle ID. |

## iOS SDK Integration Tools

This MCP server also automates Apptics iOS SDK setup inside Xcode projects.

- **`integrate_apptics_ios_sdk`** (default SPM): Adds the Apptics package, config file, disables user script sandboxing, injects imports + initialization, creates `AppticsManager.swift`, and links targets. Accepts `projectPath` and optional `targetNames` (`"all"` or specific target names).
- **`switch_apptics_dependency`**: Swap Apptics dependency between SPM and CocoaPods. Preserves optional modules and third-party dependencies in both directions.

For detailed procedures, parameters, and examples for both integration and switching, see **[IOS_SDK_PROCEDURES.md](src/tools/IOS_SDK_PROCEDURES.md)**.

Example MCP call (SPM, all targets):
```json
{
  "projectPath": "/absolute/path/to/YourApp",
  "packageManager": "spm",
  "targetNames": "all",
  "verbose": true,
  "createAppticsManagerFile": true,
  "useAppticsManagerWrapper": true
}
```

Notes:
- The pre-build script now declares an output marker (`$(DERIVED_FILE_DIR)/AppticsPreBuild.marker`) so Xcode skips reruns and avoids the "run during every build" warning, including multi-target projects.
- If auto-detection ever fails, you can optionally supply `appDelegatePath` or `swiftUIAppPath`, but this is rarely needed.
- **Build folder in project:** Integration runs a build verification step (xcodebuild). Verification uses a temp derived-data path to avoid creating `build/` in the project; if `build/` still appears, add `build/` to `.gitignore` and delete the folder if desired.

## Automatic Failure Reporting

When SDK integration fails, the tool generates a detailed failure report saved to your project directory. The report includes:

- **Categorized error types** (Prerequisites Missing, Build Failed, Configuration Error, etc.)
- **Steps completed** and **steps failed** with detailed messages
- **Environment information** (Xcode, CocoaPods, Swift versions)
- **Build output** (for build verification failures)
- **Actionable suggestions** for fixing the issue

**Example:** `apptics-integration-failure-1706123456789.json`
