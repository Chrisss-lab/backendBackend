"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

export type QueueJob = {
  id: string;
  label: string;
  status: "queued" | "running" | "done" | "error";
  /** When set, that order’s card is locked until this job finishes (queued or running). */
  orderId?: string;
  customerName?: string;
  customerPhone?: string;
};

export type QueueContext = {
  orderId?: string;
  customerName?: string;
  customerPhone?: string;
};

type ToastItem = { id: string; title: string; kind: "success" | "error"; detail?: string };

type EnqueueOptions = { showSuccessToast?: boolean; queueContext?: QueueContext };

type SheetMutationQueueContextValue = {
  enqueueMutation: <T>(label: string, fn: () => Promise<T>, opts?: EnqueueOptions) => Promise<T>;
  jobs: QueueJob[];
  toasts: ToastItem[];
  dismissToast: (id: string) => void;
  readOnlyLoading: string | null;
  setReadOnlyLoading: (v: string | null) => void;
  /** True while this order has a job queued or sending to the sheet. */
  isOrderSheetBusy: (orderId: string) => boolean;
};

const SheetMutationQueueContext = createContext<SheetMutationQueueContextValue | null>(null);

/** Small bottom chip: visible status without blocking clicks on the rest of the page. */
function SheetReadOnlyLoadingChip({ message }: { message: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={message}
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "0 12px 10px",
        pointerEvents: "none"
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          borderRadius: 999,
          background: "rgba(255, 255, 255, 0.96)",
          border: "1px solid #93c5fd",
          boxShadow: "0 2px 12px rgba(15, 23, 42, 0.1)",
          fontSize: 12,
          fontWeight: 700,
          color: "#1d4ed8",
          maxWidth: "min(380px, calc(100vw - 24px))",
          lineHeight: 1.3
        }}
      >
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            flexShrink: 0,
            border: "2px solid #bfdbfe",
            borderTopColor: "#2563eb",
            borderRadius: "50%",
            animation: "jr-loading-chip-spin 0.75s linear infinite"
          }}
        />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{message}</span>
      </div>
      <style>{`
        @keyframes jr-loading-chip-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

/** Bottom stack: optional read-only loading chip (non-blocking) + sheet job queue (interactive). */
function SheetBottomActivity({ jobs, readOnlyLoading }: { jobs: QueueJob[]; readOnlyLoading: string | null }) {
  const showJobs = jobs.length > 0;
  const showLoad = Boolean(readOnlyLoading);
  if (!showJobs && !showLoad) return null;

  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 10040,
        display: "flex",
        flexDirection: "column-reverse",
        pointerEvents: "none"
      }}
    >
      {showJobs ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            pointerEvents: "auto",
            padding: "12px 16px",
            background: "linear-gradient(180deg, rgba(248, 250, 249, 0.97), #f0fdf4)",
            borderTop: "2px solid #86efac",
            boxShadow: "0 -8px 28px rgba(22, 101, 52, 0.12)",
            maxHeight: "min(40vh, 220px)",
            overflowY: "auto"
          }}
        >
      <div style={{ fontSize: 13, color: "#1e293b" }}>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 800, color: "#0f172a", fontSize: 13, letterSpacing: "0.02em" }}>
            Sheet actions (one at a time)
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 4, lineHeight: 1.45 }}>
            Each row shows <strong>customer name</strong>, <strong>phone</strong>, and the <strong>action</strong>. Only one request is sent to Google at a time; the rest wait
            in line.
          </div>
        </div>
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {jobs.map((j) => (
              <li
                key={j.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 10,
                  background:
                    j.status === "error"
                      ? "#fef2f2"
                      : j.status === "running"
                        ? "#eff6ff"
                        : j.status === "done"
                          ? "#f0fdf4"
                          : "#fffbeb",
                  border: `1px solid ${
                    j.status === "error" ? "#fecaca" : j.status === "running" ? "#93c5fd" : j.status === "done" ? "#86efac" : "#fde68a"
                  }`
                }}
              >
                <span
                  style={{
                    fontWeight: 800,
                    fontSize: 10,
                    minWidth: 76,
                    flexShrink: 0,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    paddingTop: 2
                  }}
                >
                  {j.status === "queued" ? (
                    <span style={{ color: "#b45309" }}>Pending</span>
                  ) : j.status === "running" ? (
                    <span style={{ color: "#1d4ed8" }}>Sending…</span>
                  ) : j.status === "done" ? (
                    <span style={{ color: "#15803d" }}>Done</span>
                  ) : (
                    <span style={{ color: "#b91c1c" }}>Error</span>
                  )}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 800, fontSize: 14, color: "#0f172a", lineHeight: 1.3 }}>
                    {(j.customerName || "").trim() || "—"}{" "}
                    <span style={{ color: "#94a3b8", fontWeight: 600 }}>·</span>{" "}
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>{(j.customerPhone || "").trim() || "—"}</span>
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#334155", marginTop: 4 }}>{j.label}</div>
                  {j.orderId ? (
                    <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4, fontFamily: "ui-monospace, monospace" }}>
                      Order id: {j.orderId}
                    </div>
                  ) : null}
                </div>
                {j.status === "running" ? (
                  <span
                    aria-hidden
                    style={{
                      width: 14,
                      height: 14,
                      flexShrink: 0,
                      marginTop: 4,
                      border: "2px solid #bfdbfe",
                      borderTopColor: "#2563eb",
                      borderRadius: "50%",
                      animation: "jr-spin 0.7s linear infinite"
                    }}
                  />
                ) : null}
              </li>
            ))}
        </ul>
      </div>
          <style>{`
            @keyframes jr-spin {
              to { transform: rotate(360deg); }
            }
          `}</style>
        </div>
      ) : null}
      {showLoad && readOnlyLoading ? <SheetReadOnlyLoadingChip message={readOnlyLoading} /> : null}
    </div>
  );
}

function SheetQueueToasts({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 10060,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        maxWidth: 360,
        pointerEvents: "none"
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          style={{
            pointerEvents: "auto",
            padding: "14px 16px",
            borderRadius: 12,
            background: t.kind === "success" ? "linear-gradient(135deg, #dcfce7, #bbf7d0)" : "#fee2e2",
            border: `2px solid ${t.kind === "success" ? "#22c55e" : "#f87171"}`,
            boxShadow: "0 12px 32px rgba(15, 46, 32, 0.2)",
            animation: "jr-toast-in 0.28s ease-out"
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 800, color: t.kind === "success" ? "#166534" : "#991b1b", letterSpacing: "0.04em" }}>
                {t.kind === "success" ? "Completed" : "Failed"}
              </div>
              {t.detail ? (
                <div style={{ fontSize: 13, fontWeight: 700, color: "#334155", marginTop: 6, lineHeight: 1.35 }}>{t.detail}</div>
              ) : null}
              <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a", marginTop: t.detail ? 6 : 4 }}>{t.title}</div>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              style={{
                border: "none",
                background: "rgba(255,255,255,0.65)",
                borderRadius: 8,
                padding: "4px 8px",
                cursor: "pointer",
                fontWeight: 700,
                color: "#64748b",
                flexShrink: 0
              }}
            >
              ×
            </button>
          </div>
        </div>
      ))}
      <style>{`
        @keyframes jr-toast-in {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}

export function SheetMutationQueueProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [readOnlyLoading, setReadOnlyLoading] = useState<string | null>(null);
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const jobsRef = useRef<QueueJob[]>([]);
  /** Synchronous guard so two fast clicks cannot queue two actions for the same order. */
  const busyOrderIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const isOrderSheetBusy = useCallback((orderId: string) => {
    const oid = String(orderId || "").trim();
    if (!oid) return false;
    return jobs.some((j) => j.orderId === oid && (j.status === "queued" || j.status === "running"));
  }, [jobs]);

  const enqueueMutation = useCallback(
    <T,>(label: string, fn: () => Promise<T>, opts?: EnqueueOptions): Promise<T> => {
      const showSuccessToast = opts?.showSuccessToast !== false;
      const ctx = opts?.queueContext;
      const oid = ctx?.orderId != null && String(ctx.orderId).trim() !== "" ? String(ctx.orderId).trim() : undefined;
      if (oid) {
        const busy =
          busyOrderIdsRef.current.has(oid) ||
          jobsRef.current.some((j) => j.orderId === oid && (j.status === "queued" || j.status === "running"));
        if (busy) {
          return Promise.reject(
            new Error("This order already has an action waiting or sending. Wait for it to finish.")
          );
        }
        busyOrderIdsRef.current.add(oid);
      }

      const id = crypto.randomUUID();
      const job: QueueJob = {
        id,
        label,
        status: "queued",
        orderId: oid,
        customerName: ctx?.customerName,
        customerPhone: ctx?.customerPhone
      };
      setJobs((prev) => [...prev, job]);

      const ctxLine =
        [ctx?.customerName, ctx?.customerPhone].filter((x) => String(x || "").trim()).join(" · ") || undefined;

      const p: Promise<T> = chainRef.current.catch(() => {}).then(async () => {
        setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: "running" as const } : j)));
        try {
          const result = await fn();
          setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: "done" as const } : j)));
          if (showSuccessToast) {
            const tid = crypto.randomUUID();
            setToasts((t) => [
              ...t,
              {
                id: tid,
                title: label,
                kind: "success",
                detail: ctxLine
              }
            ]);
            window.setTimeout(() => {
              setToasts((t) => t.filter((x) => x.id !== tid));
            }, 4500);
          }
          window.setTimeout(() => {
            setJobs((j) => j.filter((x) => x.id !== id));
            if (oid) busyOrderIdsRef.current.delete(oid);
          }, 2800);
          return result;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: "error" as const } : j)));
          const tid = crypto.randomUUID();
          setToasts((t) => [
            ...t,
            {
              id: tid,
              title: label,
              kind: "error",
              detail: ctxLine ? `${ctxLine} — ${msg}` : msg
            }
          ]);
          window.setTimeout(() => {
            setToasts((t) => t.filter((x) => x.id !== tid));
          }, 9000);
          window.setTimeout(() => {
            setJobs((j) => j.filter((x) => x.id !== id));
            if (oid) busyOrderIdsRef.current.delete(oid);
          }, 6000);
          throw e;
        }
      }) as Promise<T>;

      chainRef.current = p;
      return p;
    },
    []
  );

  const value = useMemo(
    () => ({
      enqueueMutation,
      jobs,
      toasts,
      dismissToast,
      readOnlyLoading,
      setReadOnlyLoading,
      isOrderSheetBusy
    }),
    [enqueueMutation, jobs, toasts, dismissToast, readOnlyLoading, isOrderSheetBusy]
  );

  useEffect(() => {
    const hasJobs = jobs.length > 0;
    const hasLoad = Boolean(readOnlyLoading);
    if (!hasJobs && !hasLoad) return;
    if (typeof document === "undefined") return;
    const prev = document.body.style.paddingBottom;
    document.body.style.paddingBottom = hasJobs ? "max(100px, 18vh)" : hasLoad ? "52px" : prev;
    return () => {
      document.body.style.paddingBottom = prev;
    };
  }, [jobs.length, readOnlyLoading]);

  return (
    <SheetMutationQueueContext.Provider value={value}>
      {children}
      <SheetBottomActivity jobs={jobs} readOnlyLoading={readOnlyLoading} />
      <SheetQueueToasts toasts={toasts} onDismiss={dismissToast} />
    </SheetMutationQueueContext.Provider>
  );
}

export function useSheetMutationQueue(): SheetMutationQueueContextValue {
  const c = useContext(SheetMutationQueueContext);
  if (!c) throw new Error("useSheetMutationQueue must be used within SheetMutationQueueProvider");
  return c;
}
