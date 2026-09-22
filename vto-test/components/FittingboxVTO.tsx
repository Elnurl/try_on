"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FITTINGBOX_CONTAINER_ID,
  FITTINGBOX_FRAME_ID as DEFAULT_FRAME_ID,
  getFittingboxApiKey,
  loadFittingboxLibrary,
  type FitMixInstance,
  type FitMixIssue,
} from "@/lib/fittingbox";

const INIT_ERROR =
  "Virtual Try-On yüklənmədi. Browser-i yeniləyib yenidən cəhd edin.";
const CAMERA_ERROR =
  "Kamera icazəsi verilmədi. Virtual Try-On üçün kamera icazəsi lazımdır.";

let sharedInstance: FitMixInstance | null = null;
let sharedReady = false;
const readyListeners = new Set<() => void>();

function notifyReady() {
  sharedReady = true;
  readyListeners.forEach((listener) => listener());
}

function allowCameraOnIframe(container: HTMLElement) {
  const iframe = container.querySelector("iframe");
  if (!iframe) return;
  iframe.setAttribute("allow", "camera; microphone; autoplay");
  iframe.setAttribute("allowfullscreen", "true");
}

function hasActiveIssue(data: FitMixIssue) {
  return Object.values(data).some(Boolean);
}

type Props = {
  frameId?: string;
};

export default function FittingboxVTO({ frameId }: Props = {}) {
  const apiKey = getFittingboxApiKey();
  const activeFrameId = frameId ?? DEFAULT_FRAME_ID;
  const instanceRef = useRef<FitMixInstance | null>(sharedInstance);
  const readyRef = useRef(false);
  const [widgetReady, setWidgetReady] = useState(false);
  const [vtoOpen, setVtoOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userClosingRef = useRef(false);

  const handleIssue = useCallback((data: FitMixIssue) => {
    if (!hasActiveIssue(data)) return;
    console.warn("[Fittingbox] onIssue", data);

    if (data.cameraAccessDenied || data.noCameraFound) {
      setError(CAMERA_ERROR);
      return;
    }

    if (data.liveIncompatibleBrowser || data.liveIncompatibleOS) {
      setError(
        "Virtual Try-On bu browser və ya əməliyyat sistemi ilə uyğun deyil.",
      );
      return;
    }

    if (
      data.licenseNotFound ||
      data.frameNotFound ||
      data.serverNotResponding ||
      data.protocolFailed
    ) {
      setError(INIT_ERROR);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let iframeObserver: MutationObserver | null = null;

    if (!apiKey) {
      console.error(
        "[Fittingbox] NEXT_PUBLIC_FITTINGBOX_API_KEY is missing. Add it to .env.local.",
      );
      return;
    }

    const markReady = () => {
      readyRef.current = true;
      setWidgetReady(true);
    };
    readyListeners.add(markReady);

    async function initWidget() {
      try {
        const FitMix = await loadFittingboxLibrary();
        if (cancelled) return;

        const container = document.getElementById(FITTINGBOX_CONTAINER_ID);
        if (!container) {
          throw new Error("Fittingbox container is not in the DOM");
        }

        iframeObserver = new MutationObserver(() => {
          allowCameraOnIframe(container);
        });
        iframeObserver.observe(container, { childList: true, subtree: true });

        const hasIframe = !!container.querySelector("iframe");
        if (sharedInstance && hasIframe) {
          instanceRef.current = sharedInstance;
          allowCameraOnIframe(container);
          console.info("[Fittingbox] Reusing existing widget instance");
          if (sharedReady) {
            queueMicrotask(markReady);
          }
          return;
        }

        if (sharedInstance && !hasIframe) {
          console.info("[Fittingbox] Previous widget lost its iframe; recreating");
          sharedInstance = null;
          sharedReady = false;
        }

        console.info("[Fittingbox] Creating widget", {
          containerId: FITTINGBOX_CONTAINER_ID,
          frameId: activeFrameId,
        });

        const instance = FitMix.createWidget(
          FITTINGBOX_CONTAINER_ID,
          {
            apiKey,
            frame: activeFrameId,
            uiConfiguration: {
              cameraPermissionScreen: true,
              liveCameraAccessDenied: true,
              vtoLoadingScreen: true,
            },
            onIssue: handleIssue,
            onOpenStream: (value) => {
              console.info("[Fittingbox] onOpenStream", value);
              setStarting(false);
              if (!value.success) {
                setError(CAMERA_ERROR);
              }
            },
            onPrivacyTermsShown: () => {
              console.info(
                "[Fittingbox] Privacy terms shown — Agree düyməsini basın, sonra brauzer kamera icazəsi çıxacaq.",
              );
            },
            onAgreePrivacyTerms: () => {
              console.info("[Fittingbox] Privacy terms accepted");
            },
            onStopVto: () => {
              console.info("[Fittingbox] onStopVto — camera released");
              setStarting(false);
              if (userClosingRef.current) {
                userClosingRef.current = false;
                setVtoOpen(false);
              }
            },
          },
          () => {
            instance.setFrame(activeFrameId);
            allowCameraOnIframe(container);
            console.info(
              "[Fittingbox] Widget ready. Frame set:",
              activeFrameId,
            );
            notifyReady();
          },
        );

        sharedInstance = instance;
        instanceRef.current = instance;
      } catch (err) {
        console.error("[Fittingbox] Initialization failed", err);
        if (!cancelled) {
          setError(INIT_ERROR);
        }
      }
    }

    void initWidget();

    const readyTimeout = window.setTimeout(() => {
      if (!readyRef.current && !cancelled) {
        console.error("[Fittingbox] Widget did not become ready in time");
        setError(INIT_ERROR);
      }
    }, 20000);

    return () => {
      cancelled = true;
      window.clearTimeout(readyTimeout);
      readyListeners.delete(markReady);
      iframeObserver?.disconnect();
    };
  }, [apiKey, handleIssue]);

  function showOverlay() {
    const overlay = document.getElementById("vto-overlay");
    if (!overlay) return;
    overlay.style.visibility = "visible";
    overlay.classList.remove("pointer-events-none");
    overlay.setAttribute("aria-hidden", "false");
  }

  function startVto() {
    setError(null);
    userClosingRef.current = false;

    const instance = instanceRef.current;
    if (!readyRef.current || !instance) {
      console.error("[Fittingbox] startVto called before widget was ready");
      setError(INIT_ERROR);
      return;
    }

    showOverlay();
    const container = document.getElementById(FITTINGBOX_CONTAINER_ID);
    if (container) allowCameraOnIframe(container);

    setStarting(true);
    setVtoOpen(true);

    try {
      instance.setFrame(activeFrameId);
      instance.startVto("live");
      console.info("[Fittingbox] startVto('live') from user click");
    } catch (err) {
      console.error("[Fittingbox] startVto failed", err);
      setStarting(false);
      setVtoOpen(false);
      setError(INIT_ERROR);
    }
  }

  function stopVto() {
    userClosingRef.current = true;
    const instance = instanceRef.current;
    if (!instance) {
      setVtoOpen(false);
      setStarting(false);
      return;
    }

    try {
      instance.stopVto();
      console.info("[Fittingbox] stopVto()");
    } catch (err) {
      console.error("[Fittingbox] stopVto failed", err);
      setVtoOpen(false);
      setStarting(false);
    }
  }

  return (
    <div className="flex w-full flex-col items-center">
      <button
        type="button"
        onClick={startVto}
        disabled={!widgetReady || vtoOpen}
        className="mt-8 w-full rounded-full bg-zinc-900 px-6 py-3.5 text-base font-semibold text-white transition enabled:hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Üzümdə yoxla
      </button>

      {!widgetReady && !error ? (
        <p className="mt-4 text-center text-sm text-zinc-500">
          Virtual Try-On hazırlanır…
        </p>
      ) : null}

      {error || !apiKey ? (
        <p
          role="alert"
          className="mt-4 w-full text-center text-sm leading-6 text-red-600"
        >
          Xəta baş verdi. {error ?? INIT_ERROR}
        </p>
      ) : null}

      <div
        id="vto-overlay"
        className={`fixed inset-0 z-[100] flex flex-col bg-black ${
          vtoOpen ? "" : "pointer-events-none"
        }`}
        style={{ visibility: vtoOpen ? "visible" : "hidden" }}
        aria-hidden={!vtoOpen}
      >
        <div className="mx-auto flex h-[100dvh] w-full max-w-md flex-col overflow-hidden">
          <header className="flex shrink-0 items-center justify-between gap-3 px-4 py-3 text-white">
            <div>
              <p className="text-sm font-medium">Virtual Try-On</p>
              <p className="text-xs text-white/70">Kameraya icazə verin</p>
            </div>
            <button
              type="button"
              onClick={stopVto}
              className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-zinc-900"
            >
              Bağla
            </button>
          </header>

          <div className="relative min-h-0 flex-1">
            <div
              id={FITTINGBOX_CONTAINER_ID}
              className="h-full w-full"
              suppressHydrationWarning
            />
            {starting ? (
              <p className="pointer-events-none absolute inset-x-4 top-3 text-center text-xs text-white/80">
                Fittingbox şərtlərini qəbul edin, kamera açıq qalacaq
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
