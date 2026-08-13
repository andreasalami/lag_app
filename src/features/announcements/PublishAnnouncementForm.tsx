import { useState, type FormEvent } from "react";
import { supabase } from "../../lib/supabaseClient";

interface PublishAnnouncementFormProps {
  onPublished: () => void;
}

export function PublishAnnouncementForm({ onPublished }: PublishAnnouncementFormProps) {
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);

    const normalizedTitle = title.trim();
    const normalizedMessage = message.trim();
    if (!normalizedTitle || !normalizedMessage) {
      setError("Titolo e testo non possono essere vuoti.");
      setSubmitting(false);
      return;
    }

    const { error } = await supabase.from("announcements").insert({
      title: normalizedTitle,
      message: normalizedMessage,
    });

    if (error) {
      setSubmitting(false);
      setError(error.message);
      return;
    }
    const { data: pushResult, error: pushError } = await supabase.functions.invoke<{ sent: number }>("send-push-broadcast", {
      body: {
        kind: "announcement",
        title: normalizedTitle.slice(0, 80),
        message: normalizedMessage.slice(0, 240),
      },
    });
    setSubmitting(false);
    setTitle("");
    setMessage("");
    setNotice(pushError
      ? "Annuncio pubblicato, ma la notifica non è stata inviata."
      : `Annuncio pubblicato e notificato a ${pushResult?.sent ?? 0} dispositivi.`);
    onPublished();
  };

  return (
    <form onSubmit={handleSubmit} className="surface-solid mb-4 flex flex-col gap-2 rounded-[var(--radius-lg)] p-4">
      <input
        required
        maxLength={200}
        placeholder="Titolo annuncio"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="field px-3 py-2"
      />
      <textarea
        required
        maxLength={5000}
        placeholder="Testo dell'annuncio"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={2}
        className="field resize-none px-3 py-2"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting}
          className="signature-glow glass-elevated glass-elevated--strong rounded-[var(--radius-pill)] px-4 py-1.5 text-xs font-semibold disabled:opacity-50"
        >
          {submitting ? "Pubblico..." : "Pubblica annuncio"}
        </button>
        {error && <p className="text-xs text-[var(--state-error)]">{error}</p>}
      </div>
      {notice && <p className="text-xs text-[var(--text-secondary)]">{notice}</p>}
    </form>
  );
}
