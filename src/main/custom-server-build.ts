/** The local build record embedded by the main-process bundler. No profile data is included. */
export interface CustomServerBuild {
  readonly format: 1;
  readonly buildId: string;
  readonly upstreamCommit: string;
  readonly upstreamVersion: string;
  readonly builtAt: string;
}

declare const __OPENBOT_CUSTOM_SERVER_BUILD__: CustomServerBuild | null;

/** Source runs without the custom build define keep the released updater policy. */
export function getCustomServerBuild(): CustomServerBuild | null {
  return typeof __OPENBOT_CUSTOM_SERVER_BUILD__ === "undefined" ? null : __OPENBOT_CUSTOM_SERVER_BUILD__;
}

/** Official release packages do not contain this build's local changes. */
export function stockUpdatesAllowed(): boolean {
  return getCustomServerBuild() === null;
}
