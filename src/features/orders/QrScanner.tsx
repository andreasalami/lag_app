import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { readStorage, removeStorage, writeStorage } from "../../lib/browser";

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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const titleId = useId();
  const [error, setError] = useState<string | null>(null);

  // Dialog nativo modale: sfondo inerte, focus contenuto, Esc chiude (onCancel)
  // e alla chiusura il browser riporta il focus sul pulsante che l'ha aperto.
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

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
      const savedDevice = readStorage(CAMERA_DEVICE_KEY) ?? undefined;
      try {
        controls = await decode(savedDevice);
      } catch (firstError) {
        if (!savedDevice) throw firstError;
        removeStorage(CAMERA_DEVICE_KEY);
        controls = await decode();
      }
      const selectedDevice = (videoRef.current.srcObject as MediaStream | null)
        ?.getVideoTracks()[0]?.getSettings().deviceId;
      if (selectedDevice) writeStorage(CAMERA_DEVICE_KEY, selectedDevice);
    }).catch(() => {
      setError("Fotocamera non disponibile. Usa la ricerca manuale per numero e alias.");
    });
    return () => {
      stopped = true;
      controls?.stop();
    };
  }, [onDetected]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-0 h-full max-h-none w-full max-w-none border-0 bg-black p-4 text-[var(--text-primary)] open:flex open:flex-col"
    >
      <div className="mx-auto flex w-full max-w-xl items-center justify-between py-2">
        <h2 id={titleId} className="text-xl">{title}</h2>
        <Button variant="staff-secondary" onClick={onClose}>Chiudi</Button>
      </div>
      <video ref={videoRef} className="mx-auto mt-4 max-h-[70vh] w-full max-w-xl rounded-[var(--radius-lg)] bg-black object-cover" muted playsInline />
      <p className="mx-auto mt-4 max-w-xl text-center text-sm text-[var(--text-secondary)]">
        {description}
      </p>
      <p className="mx-auto mt-2 max-w-xl text-center text-xs text-[var(--text-secondary)]">
        Dopo il primo consenso verrà riutilizzata automaticamente la stessa fotocamera.
      </p>
      {error && <p role="alert" className="mx-auto mt-3 max-w-xl text-center text-sm text-[var(--state-error)]">{error}</p>}
    </dialog>
  );
}
