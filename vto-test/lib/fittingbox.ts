export const FITTINGBOX_SCRIPT_URL =
  "https://vto-advanced-integration-api.fittingbox.com/index.js";

export const FITTINGBOX_FRAME_ID =
  process.env.NEXT_PUBLIC_FITTINGBOX_FRAME_ID ?? "00192950009483";

export const FITTINGBOX_CONTAINER_ID = "fitmix-container";

export type FitMixIssue = {
  cameraAccessDenied: boolean;
  detectionFailed: boolean;
  frameNotFound: boolean;
  highLatency: boolean;
  licenseNotFound: boolean;
  liveIncompatibleBrowser: boolean;
  liveIncompatibleOS: boolean;
  noCameraFound: boolean;
  poseInvalid: boolean;
  protocolFailed: boolean;
  removalLowPerformances: boolean;
  serverNotResponding: boolean;
  trackingLost: boolean;
};

export type FitMixInstance = {
  setFrame: (id: string) => void;
  startVto: (mode: "live" | "photo" | "faceshape") => void;
  stopVto: () => void;
};

export type FitMixUiConfiguration = {
  cameraPermissionScreen?: boolean;
  liveCameraAccessDenied?: boolean;
  vtoLoadingScreen?: boolean;
};

export type FitMixParams = {
  apiKey: string;
  frame?: string;
  uiConfiguration?: FitMixUiConfiguration;
  onIssue?: (data: FitMixIssue) => void;
  onOpenStream?: (value: { success: boolean }) => void;
  onPrivacyTermsShown?: () => void;
  onAgreePrivacyTerms?: () => void;
  onStopVto?: () => void;
};

export type FitMixAPI = {
  createWidget: (
    containerId: string,
    params: FitMixParams,
    onReady: () => void,
  ) => FitMixInstance;
};

declare global {
  interface Window {
    FitMix?: FitMixAPI;
  }
}

export function getFittingboxApiKey(): string {
  return process.env.NEXT_PUBLIC_FITTINGBOX_API_KEY ?? "";
}

export function loadFittingboxLibrary(): Promise<FitMixAPI> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Fittingbox can only load in the browser"));
  }

  if (window.FitMix) {
    return Promise.resolve(window.FitMix);
  }

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${FITTINGBOX_SCRIPT_URL}"]`,
    );

    const finish = () => {
      if (window.FitMix) {
        resolve(window.FitMix);
        return;
      }
      reject(new Error("FitMix global is missing after script load"));
    };

    if (existing) {
      const started = Date.now();
      const poll = window.setInterval(() => {
        if (window.FitMix) {
          window.clearInterval(poll);
          resolve(window.FitMix);
          return;
        }
        if (Date.now() - started > 15000) {
          window.clearInterval(poll);
          reject(new Error("Fittingbox script is present but FitMix did not initialize"));
        }
      }, 50);
      existing.addEventListener(
        "error",
        () => {
          window.clearInterval(poll);
          reject(new Error("Fittingbox script failed to load"));
        },
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = FITTINGBOX_SCRIPT_URL;
    script.type = "text/javascript";
    // Official docs: load once, synchronously (no async / defer).
    script.async = false;
    script.defer = false;
    script.onload = finish;
    script.onerror = () => reject(new Error("Fittingbox script failed to load"));
    document.head.appendChild(script);
  });
}
