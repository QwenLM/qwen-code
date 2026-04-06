export interface QwenTestOauthCredentials {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
  resource_url?: string;
  id_token?: string;
}

export interface QwenTestOauthEnvMap {
  [key: string]: string | undefined;
}

export declare function resolveOauthCredsFromEnv(
  env?: QwenTestOauthEnvMap,
): QwenTestOauthCredentials;

export declare function getOauthCredsPath(homeDir?: string): string;

export declare function installOauthCredsFromEnv(
  env?: QwenTestOauthEnvMap,
  homeDir?: string,
): Promise<string>;
