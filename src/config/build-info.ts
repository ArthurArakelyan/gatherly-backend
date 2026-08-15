export interface BuildInfo {
  environment: string;
  revision: string;
  imageDigest?: string;
  slot: string;
}

export const createBuildInfo = (input: NodeJS.ProcessEnv = process.env): BuildInfo => ({
  environment: input['DEPLOYMENT_ENVIRONMENT'] ?? 'development',
  revision: input['APP_REVISION'] ?? 'development',
  ...(input['APP_IMAGE_DIGEST'] === undefined ? {} : { imageDigest: input['APP_IMAGE_DIGEST'] }),
  slot: input['DEPLOYMENT_SLOT'] ?? 'local',
});
