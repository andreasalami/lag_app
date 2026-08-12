import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";

type Props = { onDetected: (value: string) => void; onClose: () => void };

export function QrScanner({ onDetected, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let controls: { stop: () => void } | undefined;
    void import("@zxing/browser").then(async ({ BrowserQRCodeReader }) => {
      if (!videoRef.current || stopped) return;
      const reader = new BrowserQRCodeReader();
      controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
        if (!stopped && result) {
          stopped = true;
          controls?.stop();
          onDetected(result.getText());
        }
      });
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
        <h2 className="text-xl">Scansiona il QR</h2>
        <Button variant="ghost" onClick={onClose}>Chiudi</Button>
      </div>
      <video ref={videoRef} className="mx-auto mt-4 max-h-[70vh] w-full max-w-xl rounded-[var(--radius-lg)] bg-black object-cover" muted playsInline />
      <p className="mx-auto mt-4 max-w-xl text-center text-sm text-[var(--text-secondary)]">
        Inquadra il QR mostrato sul telefono del cliente.
      </p>
      {error && <p className="mx-auto mt-3 max-w-xl text-center text-sm text-[var(--state-error)]">{error}</p>}
    </div>
  );
}
