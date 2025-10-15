export type AppticsNetworkClientOptions = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  appticsUri?: string;
  accountsUri?: string;
  accessToken?: string | null;
};

type AppticsTokenResponse = {
  access_token: string;
  refresh_token?: string;
};

export class AppticsNetworkClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private refreshToken: string;
  private readonly appticsUri: string;
  private readonly accountsUri: string;
  private accessToken: string | null;

  constructor({
    clientId,
    clientSecret,
    refreshToken,
    appticsUri = "https://apptics.zoho.com/",
    accountsUri = "https://accounts.zoho.com/"
  }: AppticsNetworkClientOptions) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.refreshToken = refreshToken;
    this.appticsUri = appticsUri;
    this.accountsUri = accountsUri;
    this.accessToken = null;
  }

  private formatDate(date: Date): string {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
  }

  // provide default last 7 days date range
  private getStartAndEndDate(
    startDate?: string,
    endDate?: string
  ): { startDate: string, endDate: string} {
    let sDate: string;
    let eDate: string;
    if (!startDate || !endDate) {
       const now = new Date();

      const end = new Date(now);
      end.setDate(end.getDate() - 1);
      
      const start = new Date(now);
      start.setDate(start.getDate() - 7);

      sDate = this.formatDate(start);
      eDate = this.formatDate(end);
    } else {
      sDate = startDate;
      eDate = endDate;
    }
    return {
      startDate: sDate,
      endDate: eDate
    };
  }

  private async httpRequest(url: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(url, init);
    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Failed to get crashes count. ${response.status} \n ${err}`)
    }
    return response.json() as {}
  }

  async getCrashList(
    projectId: string,
    zsoId: string,
    startDate?: string,
    endDate?: string,
    appVersion?: string,
    platform?: string,
    mode?: string,
    offset?: string,
    limit?: string
  ): Promise<unknown> {
    const accessToken = await this.getAccessToken();

    const startAndEndDate = this.getStartAndEndDate(startDate, endDate);
    const queryParams = new URLSearchParams({
      startdate: startAndEndDate.startDate,
      enddate: startAndEndDate.endDate,
    });

    if (appVersion != null) {
      queryParams.set("appversion", appVersion)
    }
    if (platform != null) {
      queryParams.set("platform", platform)
    }
    if (mode != null) {
      queryParams.set("mode", "1")
    }
    if (offset != null) {
      queryParams.set("offset", offset)
    }
    if (limit != null) {
      queryParams.set("limit", limit)
    } else {
      queryParams.set("limit", "20")
    }

    return await this.httpRequest(`${this.appticsUri}cx/api/v1/crash/list?${queryParams}`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        projectid: projectId,
        zsoid: zsoId
      }
    });
  }

  async getCrashCountSummary(
    projectId: string,
    zsoId: string,
    startDate?: string,
    endDate?: string,
    appVersion?: string,
    platform?: string
  ): Promise<unknown> {
    const accessToken = await this.getAccessToken();

    const startAndEndDate = this.getStartAndEndDate(startDate, endDate);
    
    const queryParams = new URLSearchParams({
      startdate: startAndEndDate.startDate,
      enddate: startAndEndDate.endDate,
    });

    if (appVersion != null) {
      queryParams.set("appversion", appVersion)
    }
    if (platform != null) {
      queryParams.set("platform", platform)
    }

    return await this.httpRequest(`${this.appticsUri}cx/api/v1/crash/summary?${queryParams}`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        projectid: projectId,
        zsoid: zsoId
      }
    });
  }

  async getCrashDetail(
    projectId: string,
    zsoId: string,
    uniqueId: string,
    startDate?: string,
    endDate?: string,
    appVersion?: string
  ): Promise<unknown> {
    const accessToken = this.getAccessToken();

    const startAndEndDate = this.getStartAndEndDate(startDate, endDate);
    
    const queryParams = new URLSearchParams({
      startdate: startAndEndDate.startDate,
      enddate: startAndEndDate.endDate
    });

    if (appVersion != null) {
      queryParams.set("appversion", appVersion)
    }

    return await this.httpRequest(`${this.appticsUri}cx/api/v1/crash/${uniqueId}/summarywithtrace?${queryParams}`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        projectid: projectId,
        zsoid: zsoId
      }
    });
  }


  async getCrashCountByDate(
    projectId: string,
    zsoId: string,
    startDate?: string,
    endDate?: string,
    appVersion?: string,
    platform?: string
  ): Promise<unknown> {
    const accessToken = await this.getAccessToken();

    const startAndEndDate = this.getStartAndEndDate(startDate, endDate);
    
    const queryParams = new URLSearchParams({
      startdate: startAndEndDate.startDate,
      enddate: startAndEndDate.endDate,
    });

    if (appVersion != null) {
      queryParams.set("appversion", appVersion);
    }
    if (platform != null) {
      queryParams.set("platform", platform);
    }

    return await this.httpRequest(`${this.appticsUri}cx/api/v1/crash/countbydate?${queryParams}`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        projectid: projectId,
        zsoid: zsoId
      }
    });
  }

  async getDeviceSpecificCrashDistribution(
    projectId: string,
    zsoId: string,
    uniqueId: string,
    startDate? : string,
    endDate? : string,
    appVersion?: string,
    limit?: string,
    offset?: string
  ): Promise<unknown> {
    const accessToken = await this.getAccessToken();

    const startAndEndDate = this.getStartAndEndDate(startDate, endDate);
    
    const queryParams = new URLSearchParams({
      startdate: startAndEndDate.startDate,
      enddate: startAndEndDate.endDate
    });

    if (appVersion != null) {
      queryParams.set("appversion", appVersion);
    }
    if (limit != null) {
      queryParams.set("limit", limit);
    } else {
      queryParams.set("limit", "20");
    }
    if (offset != null) {
      queryParams.set("offset", offset);
    }

    return await this.httpRequest(`${this.appticsUri}cx/api/v1/crash/devicemodel?${queryParams}`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        projectid: projectId,
        zsoid: zsoId
      }
    });
  }


  async getActiveDevices(
    projectId: string,
    zsoId: string,
    startDate?: string,
    endDate?: string,
    group?: string
  ): Promise<unknown> {
    const accessToken = await this.getAccessToken();

    let sDate: string;
    let eDate: string;
    if (!startDate || !endDate) {
       const now = new Date();

      const end = new Date(now);
      end.setDate(end.getDate() - 1);
      
      const start = new Date(now);
      start.setDate(start.getDate() - 7);

      sDate = this.formatDate(start);
      eDate = this.formatDate(end);
    } else {
      sDate = startDate;
      eDate = endDate;
    }
  
    const queryParams = new URLSearchParams({
      startdate: sDate,
      enddate: eDate,
      group: group ?? "platform"
    });

    return this.httpRequest(`${this.appticsUri}cx/api/v1/activedevice/multigroup?${queryParams}`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        projectid: projectId,
        zsoid: zsoId
      }
    });
  }

  async getPortalsAndProjects(): Promise<unknown> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${this.appticsUri}cx/api/v1/userprojects`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error("Failed while fetching portals and projects");
    }

    const data = await response.json() as { result?: unknown };
    return data.result ?? data;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken) {
      return this.accessToken;
    }

    await this.refreshAccessToken();

    if (!this.accessToken) {
      throw new Error("Failed to obtain access token");
    }

    return this.accessToken;
  }

  private async refreshAccessToken(): Promise<void> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret
    });

    const response = await fetch(this.accountsUri + "oauth/v2/token", {
      method: "POST",
      body
    });

    if (!response.ok) {
      const err = response.text();
      throw new Error(`Failed to obtain access token. ${response.status} \n ${err}`)
    }

    const data = await response.json() as AppticsTokenResponse;
    this.accessToken = data.access_token;

    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
    }
  }

}
