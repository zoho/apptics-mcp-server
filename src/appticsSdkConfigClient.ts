/**
 * Wrapper around AppticsNetworkClient for SDK config API (applications and config file).
 * Uses existing client for auth and base URL; no duplicated logic.
 * Endpoints: ec/api/v1/applications, ec/api/v1/downloadconfigfile
 */

import type { AppticsNetworkClient } from "./appticsNetworkClient";

export class AppticsSdkConfigClient {
  constructor(private readonly client: AppticsNetworkClient) {}

  /**
   * GET ec/api/v1/applications
   * Retrieves a list of applications for the specified project.
   */
  async getApplications(projectId: string, zsoId: string): Promise<unknown> {
    const accessToken = await this.client.getAuthToken();
    const baseUri = this.client.getAppticsUri();
    const response = await fetch(`${baseUri}ec/api/v1/applications`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        projectid: projectId,
        zsoid: zsoId
      }
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Request failed. ${response.status} \n ${err}`);
    }
    return response.json() as unknown;
  }

  /**
   * GET ec/api/v1/downloadconfigfile?aaid={aaid}
   * Downloads the configuration file (plist for iOS) for a specific application.
   * Returns the response body as string (XML/plist).
   */
  async downloadConfigFile(
    projectId: string,
    zsoId: string,
    aaid: number
  ): Promise<string> {
    const accessToken = await this.client.getAuthToken();
    const baseUri = this.client.getAppticsUri();
    const response = await fetch(
      `${baseUri}ec/api/v1/downloadconfigfile?aaid=${aaid}`,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          projectid: projectId,
          zsoid: zsoId
        }
      }
    );
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Request failed. ${response.status} \n ${err}`);
    }
    return response.text();
  }
}
