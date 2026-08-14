export interface RuntimeInfo {
  platform: NodeJS.Platform;
  arch: string;
  version: string;
}

export interface DesktopBridge {
  runtime: {
    getInfo(): Promise<RuntimeInfo>;
  };
}
