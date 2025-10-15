import dotenv from "dotenv";
import { z } from "zod";
import {
  AppticsNetworkClient,
  AppticsNetworkClientOptions
} from "./appticsNetworkClient";

dotenv.config({ quiet: true });

const appticsEnvSchema = z.object({
  APPTICS_CLIENT_ID: z.string().min(1),
  APPTICS_CLIENT_SECRET: z.string().min(1),
  APPTICS_REFRESH_TOKEN: z.string().min(1),
  APPTICS_SERVER_URI: z.string().url().optional(),
  APPTICS_ACCOUNTS_URI: z.string().url().optional(),
  APPTICS_ACCESS_TOKEN: z.string().optional()
});

let cachedClient: AppticsNetworkClient | undefined;

export function loadAppticsClientOptions(): AppticsNetworkClientOptions {
  const env = appticsEnvSchema.parse(process.env);

  const options: AppticsNetworkClientOptions = {
    clientId: env.APPTICS_CLIENT_ID,
    clientSecret: env.APPTICS_CLIENT_SECRET,
    refreshToken: env.APPTICS_REFRESH_TOKEN
  };

  if (env.APPTICS_SERVER_URI) {
    options.appticsUri = env.APPTICS_SERVER_URI;
  }
  if (env.APPTICS_ACCOUNTS_URI) {
    options.accountsUri = env.APPTICS_ACCOUNTS_URI;
  }
  if (env.APPTICS_ACCESS_TOKEN) {
    options.accessToken = env.APPTICS_ACCESS_TOKEN;
  }

  return options;
}

export function getAppticsClient(): AppticsNetworkClient {
  if (!cachedClient) {
    const options = loadAppticsClientOptions();
    cachedClient = new AppticsNetworkClient(options);
  }

  return cachedClient;
}
