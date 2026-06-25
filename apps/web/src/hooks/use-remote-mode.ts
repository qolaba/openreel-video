import { useState, useEffect, useCallback, useRef } from "react";
import { useProjectStore } from "../stores/project-store";
import { toast } from "../stores/notification-store";

// --- PostMessage protocol types ---

/** Messages the parent frame can send to the editor */
type ParentMessage =
  | { type: "load-video"; videoUrl: string; seriesId?: string }
  | { type: "request-export"; format?: string };

/** Messages the editor sends back to the parent frame */
type EditorMessage =
  | { type: "ready" }
  | { type: "video-loaded"; success: boolean; mediaId?: string; error?: string }
  | { type: "export-started" }
  | { type: "export-progress"; progress: number; phase: string }
  | { type: "export-complete"; videoBlob: Blob; format: string }
  | { type: "export-error"; error: string };

// --- URL parameter parsing ---

interface RemoteModeParams {
  enabled: boolean;
  videoUrl: string | null;
  seriesId: string | null;
  /** Restrict postMessage to this origin. Defaults to '*' if not set. */
  parentOrigin: string | null;
}

function parseRemoteParams(): RemoteModeParams {
  const url = new URL(window.location.href);
  const mode = url.searchParams.get("mode");
  return {
    enabled: mode === "remote",
    videoUrl: url.searchParams.get("videoUrl"),
    seriesId: url.searchParams.get("seriesId"),
    parentOrigin: url.searchParams.get("parentOrigin"),
  };
}

// --- Hook ---

export function useRemoteMode() {
  const [params] = useState(parseRemoteParams);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasLoaded = useRef(false);

  const { importMedia, createNewProject } = useProjectStore();

  const parentOrigin = params.parentOrigin ?? "*";

  const sendToParent = useCallback(
    (message: EditorMessage) => {
      if (!params.enabled || !window.parent || window.parent === window) return;
      // Blobs can't be sent via postMessage structured clone to cross-origin.
      // For export-complete we transfer the blob as-is (same-origin) or
      // the parent can read it from a temporary object URL.
      window.parent.postMessage(
        { source: "openreel-remote", ...message },
        parentOrigin,
      );
    },
    [params.enabled, parentOrigin],
  );

  // Fetch video from URL, create a File, and import it
  const loadVideoFromUrl = useCallback(
    async (videoUrl: string) => {
      if (loading) return;
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(videoUrl, { mode: "cors" });
        if (!response.ok) {
          throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`);
        }

        const blob = await response.blob();
        const contentType = blob.type || "video/mp4";
        const ext = contentType.includes("webm") ? "webm" : "mp4";
        const filename = `remote-video.${ext}`;
        const file = new File([blob], filename, { type: contentType });

        const result = await importMedia(file);

        if (result.success) {
          sendToParent({ type: "video-loaded", success: true });
          toast.success("Video loaded", "Remote video imported into the editor.");
        } else {
          const errMsg = result.error?.message || "Failed to import video";
          sendToParent({ type: "video-loaded", success: false, error: errMsg });
          setError(errMsg);
          toast.error("Import failed", errMsg);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error loading video";
        sendToParent({ type: "video-loaded", success: false, error: errMsg });
        setError(errMsg);
        toast.error("Import failed", errMsg);
      } finally {
        setLoading(false);
      }
    },
    [loading, importMedia, sendToParent],
  );

  // On mount: if remote mode with a videoUrl, auto-create project & import
  useEffect(() => {
    if (!params.enabled || hasLoaded.current) return;
    hasLoaded.current = true;

    // Create a fresh project for the remote video
    createNewProject("Remote Edit", {
      width: 1920,
      height: 1080,
      frameRate: 30,
    });

    sendToParent({ type: "ready" });

    if (params.videoUrl) {
      loadVideoFromUrl(params.videoUrl);
    }
  }, [params.enabled, params.videoUrl, createNewProject, sendToParent, loadVideoFromUrl]);

  // Listen for postMessage commands from the parent frame
  useEffect(() => {
    if (!params.enabled) return;

    const handleMessage = (event: MessageEvent) => {
      const data = event.data as ParentMessage | undefined;
      if (!data || typeof data.type !== "string") return;

      switch (data.type) {
        case "load-video":
          if (data.videoUrl) {
            loadVideoFromUrl(data.videoUrl);
          }
          break;
        case "request-export":
          // Export is handled by the Toolbar via the remote export button.
          // This message is a convenience trigger — we dispatch a custom event
          // so the Toolbar can pick it up without coupling stores.
          window.dispatchEvent(
            new CustomEvent("openreel-remote-export", {
              detail: { format: data.format ?? "mp4" },
            }),
          );
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [params.enabled, loadVideoFromUrl]);

  return {
    isRemoteMode: params.enabled,
    seriesId: params.seriesId,
    loading,
    error,
    sendToParent,
  };
}
