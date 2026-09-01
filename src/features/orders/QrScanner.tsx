import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";

type Props = {
  onDetected: (value: string) => void;
  onClose: () => void;
  title?: string;
  description?: string;
};

const CAMERA_DEVICE_KEY = "lag:qr-camera-device";

export function QrScanner({
  onDetected,
  onClose,
  title = "Scansiona il QR",
  description = "Inquadra il QR mostrato sul telefono del cliente.",
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let controls: { stop: () => void } | undefined;
    void import("@zxing/browser").then(async ({ BrowserQRCodeReader }) => {
      if (!videoRef.current || stopped) return;
      const reader = new BrowserQRCodeReader();
      const decode = (deviceId?: string) => reader.decodeFromVideoDevice(deviceId, videoRef.current ?? undefined, (result) => {
        if (!stopped && result) {
          stopped = true;
          controls?.stop();
          onDetected(result.getText());
        }
      });
      const savedDevice = localStorage.getItem(CAMERA_DEVICE_KEY) ?? undefined;
      try {
        controls = await decode(savedDevice);
      } catch (firstError) {
        if (!savedDevice) throw firstError;
        localStorage.removeItem(CAMERA_DEVICE_KEY);
        controls = await decode();
      }
      const selectedDevice = (videoRef.current.srcObject as MediaStream | null)
        ?.getVideoTracks()[0]?.getSettings().deviceId;
      if (selectedDevice) localStorage.setItem(CAMERA_DEVICE_KEY, selectedDevice);
    }).catch(() => {
      setError("Fotocamera non disponibile. Usa la ricerca manuale per numero e alias.");
    });
    return () => {
      stopped = true;
      controls?.stop();
    };
  }, [onDetected]);

  return (
    <div className="fixed inset-0 z-[110] flex flex-col bg-black p-4">
      <div className="mx-auto flex w-full max-w-xl items-center justify-between py-2">
        <h2 className="text-xl">{title}</h2>
        <Button variant="staff-secondary" onClick={onClose}>Chiudi</Button>
      </div>
      <video ref={videoRef} className="mx-auto mt-4 max-h-[70vh] w-full max-w-xl rounded-[var(--radius-lg)] bg-black object-cover" muted playsInline />
      <p className="mx-auto mt-4 max-w-xl text-center text-sm text-[var(--text-secondary)]">
        {description}
      </p>
      <p className="mx-auto mt-2 max-w-xl text-center text-xs text-[var(--text-secondary)]">
        Dopo il primo consenso verrà riutilizzata automaticamente la stessa fotocamera.
      </p>
      {error && <p className="mx-auto mt-3 max-w-xl text-center text-sm text-[var(--state-error)]">{error}</p>}
    </div>
  );
}
