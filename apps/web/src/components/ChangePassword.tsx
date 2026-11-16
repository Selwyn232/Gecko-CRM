import { useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorBox, Field, Modal } from "./ui";

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) return setError("De nieuwe wachtwoorden zijn niet gelijk");
    try {
      await api.post("/auth/change-password", { currentPassword: current, newPassword: next });
      setDone(true);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Modal title="Wachtwoord wijzigen" onClose={onClose}>
      {done ? (
        <>
          <div className="alert info">Wachtwoord gewijzigd. Andere sessies zijn uitgelogd.</div>
          <div className="modal-actions"><button className="btn primary" onClick={onClose}>Sluiten</button></div>
        </>
      ) : (
        <form onSubmit={submit}>
          <ErrorBox error={error} />
          <Field label="Huidig wachtwoord"><input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></Field>
          <Field label="Nieuw wachtwoord (min. 12 tekens)"><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} /></Field>
          <Field label="Herhaal nieuw wachtwoord"><input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required /></Field>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>Annuleren</button>
            <button className="btn primary">Opslaan</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
