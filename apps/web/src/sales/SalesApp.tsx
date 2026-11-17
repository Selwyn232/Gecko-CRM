import { PasskeysButton } from "../components/Passkeys";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { ChangePasswordModal } from "../components/ChangePassword";
import { ErrorBox, Field, Loading, Modal, PageHead } from "../components/ui";
import { formatCents, formatDate, formatPercent, formatQty } from "../format";

interface SalesMe {
  organization: { id: string; name: string };
  advisorId: string | null;
  advisors: { id: string; name: string }[];
  channels: { id: string; name: string; feeBasisPoints: number | null; productGroups: { id: string; name: string }[] }[];
}
interface SalesQuoteRow {
  id: string;
  displayNumber: string;
  kind: string;
  status: string;
  customer: { id: string; name: string };
  advisor: string | null;
  validUntil: string | null;
  acceptedAt: string | null;
  projectStatus: string | null;
  totals: { subtotalCents: number; totalCents: number };
}
interface SalesQuote {
  id: string;
  displayNumber: string;
  status: string;
  effectiveStatus: string;
  salesChannelId: string;
  productGroupId: string;
  validUntil: string | null;
  acceptedAt: string | null;
  acceptedByName: string | null;
  customer: { firstName: string | null; lastName: string; email: string | null };
  property: { street: string; houseNumber: string; postalCode: string; city: string };
  productGroup: { name: string };
  advisor: { name: string } | null;
  lines: { id: string; description: string; quantity: string; unitPriceCents: number; vatRateBasisPoints: number; lineTotalCents: number }[];
  totals: { subtotalCents: number; vatCents: number; totalCents: number };
  projectStatus: { status: string; phase: string } | null;
}
interface SalesCustomer { id: string; displayNumber: string; firstName: string | null; lastName: string; email: string | null; properties: { id: string; street: string; houseNumber: string; city: string }[] }

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "Concept", cls: "" },
  sent: { label: "Verstuurd", cls: "yellow" },
  accepted: { label: "Geaccepteerd", cls: "green" },
  rejected: { label: "Afgewezen", cls: "red" },
  expired: { label: "Verlopen", cls: "red" },
  superseded: { label: "Vervangen", cls: "" },
};
const Badge = ({ s }: { s: string }) => <span className={`badge ${STATUS[s]?.cls ?? ""}`}>{STATUS[s]?.label ?? s}</span>;

/** Portaal voor verkooppartners (Greenteam): eigen klanten en offertes, en de eigen fee. */
export function SalesApp() {
  const { me, logout } = useAuth();
  const [changingPassword, setChangingPassword] = useState(false);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">G</span> Verkoopportaal</div>
        <nav className="nav">
          <NavLink to="/offertes">Offertes</NavLink>
          <NavLink to="/klanten">Klanten</NavLink>
          <NavLink to="/fee">Mijn fee</NavLink>
        </nav>
        <div className="sidebar-footer">
          <div style={{ color: "var(--text)", fontWeight: 500 }}>{me?.name}</div>
          <div>{me?.organizationName}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => setChangingPassword(true)}>Wachtwoord</button>
            <PasskeysButton />
            <button className="btn small" onClick={logout}>Uitloggen</button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/offertes" replace />} />
          <Route path="/offertes" element={<SalesQuotes />} />
          <Route path="/offertes/:id" element={<SalesQuoteDetail />} />
          <Route path="/klanten" element={<SalesCustomers />} />
          <Route path="/fee" element={<SalesFees />} />
          <Route path="*" element={<Navigate to="/offertes" replace />} />
        </Routes>
      </main>
      {changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />}
    </div>
  );
}

const useSalesMe = () => useQuery({ queryKey: ["sales-me"], queryFn: () => api.get<SalesMe>("/sales/me") });

function SalesQuotes() {
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ["sales-quotes"], queryFn: () => api.get<SalesQuoteRow[]>("/sales/quotes") });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHead title="Offertes" sub="Offertes namens Gecko. Na akkoord van de klant volgt u hier de status van het project." actions={<button className="btn primary" onClick={() => setCreating(true)}>Nieuwe offerte</button>} />
      <div className="card flush">
        {list.isLoading ? <Loading /> : !list.data?.length ? <div className="empty">Nog geen offertes.</div> : (
          <table>
            <thead><tr><th>Nr.</th><th>Klant</th><th>Adviseur</th><th>Status</th><th>Project</th><th className="num">Excl. btw</th></tr></thead>
            <tbody>
              {list.data.map((q) => (
                <tr key={q.id} className="clickable" onClick={() => navigate(`/offertes/${q.id}`)}>
                  <td className="mono">{q.displayNumber}{q.kind === "extra_work" && <span className="badge" style={{ marginLeft: 6 }}>meerwerk</span>}</td>
                  <td>{q.customer.name}</td>
                  <td>{q.advisor ?? <span className="muted">—</span>}</td>
                  <td><Badge s={q.status} /></td>
                  <td style={{ fontSize: 13 }}>{q.projectStatus ?? <span className="muted">—</span>}</td>
                  <td className="num">{formatCents(q.totals.subtotalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <NewQuote onClose={() => setCreating(false)} onCreated={(id) => navigate(`/offertes/${id}`)} />}
    </>
  );
}

function NewQuote({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const me = useSalesMe();
  const qc = useQueryClient();
  const customers = useQuery({ queryKey: ["sales-customers"], queryFn: () => api.get<SalesCustomer[]>("/sales/customers") });
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [customerId, setCustomerId] = useState("");
  const [cust, setCust] = useState({ firstName: "", lastName: "", email: "", phone: "", street: "", houseNumber: "", postalCode: "", city: "" });
  const [channelId, setChannelId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [advisorId, setAdvisorId] = useState("");
  const channel = me.data?.channels.find((c) => c.id === (channelId || me.data?.channels[0]?.id));
  const save = useMutation({
    mutationFn: async () => {
      const ch = channel!.id;
      let c: SalesCustomer;
      if (mode === "new") {
        const e = (v: string) => v.trim() || null;
        c = await api.post<SalesCustomer>("/sales/customers", {
          firstName: e(cust.firstName), lastName: cust.lastName, email: e(cust.email), phone: e(cust.phone), salesChannelId: ch,
          property: { street: cust.street, houseNumber: cust.houseNumber, postalCode: cust.postalCode, city: cust.city },
        });
      } else {
        c = customers.data!.find((x) => x.id === customerId)!;
      }
      return api.post<{ id: string }>("/sales/quotes", {
        customerId: c.id, propertyId: c.properties[0]!.id, productGroupId: groupId || channel!.productGroups[0]!.id, salesChannelId: ch,
        advisorId: me.data!.advisorId ?? (advisorId || null),
      });
    },
    onSuccess: async (q) => {
      await qc.invalidateQueries({ queryKey: ["sales-quotes"] });
      onCreated(q.id);
    },
  });
  if (!me.data) return null;
  const set = (k: keyof typeof cust) => (e: React.ChangeEvent<HTMLInputElement>) => setCust({ ...cust, [k]: e.target.value });
  return (
    <Modal title="Nieuwe offerte" onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <ErrorBox error={save.error} />
        <div className="tabs">
          <button type="button" className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>Nieuwe klant</button>
          <button type="button" className={mode === "existing" ? "active" : ""} onClick={() => setMode("existing")} disabled={!customers.data?.length}>Bestaande klant</button>
        </div>
        {mode === "existing" ? (
          <Field label="Klant">
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
              <option value="">Kies…</option>
              {customers.data?.map((c) => <option key={c.id} value={c.id}>{[c.firstName, c.lastName].filter(Boolean).join(" ")} — {c.properties[0]?.street} {c.properties[0]?.houseNumber}, {c.properties[0]?.city}</option>)}
            </select>
          </Field>
        ) : (
          <>
            <div className="grid-2">
              <Field label="Voornaam"><input value={cust.firstName} onChange={set("firstName")} /></Field>
              <Field label="Achternaam"><input value={cust.lastName} onChange={set("lastName")} required /></Field>
              <Field label="E-mail (voor de offerte)"><input type="email" value={cust.email} onChange={set("email")} required /></Field>
              <Field label="Telefoon"><input value={cust.phone} onChange={set("phone")} /></Field>
              <Field label="Straat"><input value={cust.street} onChange={set("street")} required /></Field>
              <Field label="Huisnummer"><input value={cust.houseNumber} onChange={set("houseNumber")} required /></Field>
              <Field label="Postcode"><input value={cust.postalCode} onChange={set("postalCode")} required /></Field>
              <Field label="Plaats"><input value={cust.city} onChange={set("city")} required /></Field>
            </div>
          </>
        )}
        <div className="grid-2">
          {me.data.channels.length > 1 && (
            <Field label="Kanaal"><select value={channel?.id} onChange={(e) => setChannelId(e.target.value)}>{me.data.channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          )}
          <Field label="Productgroep">
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              {channel?.productGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
          {!me.data.advisorId && (
            <Field label="Adviseur">
              <select value={advisorId} onChange={(e) => setAdvisorId(e.target.value)}>
                <option value="">—</option>
                {me.data.advisors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Annuleren</button>
          <button className="btn primary" disabled={save.isPending || !channel}>Offerte maken</button>
        </div>
      </form>
    </Modal>
  );
}

function SalesQuoteDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["sales-quote", id], queryFn: () => api.get<SalesQuote>(`/sales/quotes/${id}`) });
  const catalog = useQuery({
    queryKey: ["sales-catalog", q.data?.salesChannelId, q.data?.productGroupId],
    queryFn: () => api.get<{ id: string; code: string; name: string; type: string; unit: string; priceCents: number }[]>(`/sales/catalog?channelId=${q.data!.salesChannelId}&productGroupId=${q.data!.productGroupId}`),
    enabled: !!q.data && q.data.status === "draft",
  });
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const refresh = (d: SalesQuote) => {
    qc.setQueryData(["sales-quote", id], d);
    void qc.invalidateQueries({ queryKey: ["sales-quotes"] });
  };
  const add = useMutation({ mutationFn: () => api.post<SalesQuote>(`/sales/quotes/${id}/lines`, { productId, quantity: Number(qty.replace(",", ".")) || 1 }), onSuccess: (d) => { refresh(d); setProductId(""); setQty("1"); } });
  const remove = useMutation({ mutationFn: (lineId: string) => api.del<SalesQuote>(`/sales/quotes/${id}/lines/${lineId}`), onSuccess: refresh });
  const send = useMutation({ mutationFn: () => api.post<SalesQuote & { sentTo: string; emailStatus: string }>(`/sales/quotes/${id}/send`), onSuccess: refresh });
  if (q.isLoading) return <Loading />;
  if (!q.data) return <ErrorBox error={q.error} />;
  const d = q.data;
  const draft = d.status === "draft";
  return (
    <>
      <div style={{ marginBottom: 8 }}><Link to="/offertes">← Offertes</Link></div>
      <PageHead
        title={`Offerte ${d.displayNumber}`}
        sub={`${[d.customer.firstName, d.customer.lastName].filter(Boolean).join(" ")} · ${d.property.street} ${d.property.houseNumber}, ${d.property.city} · ${d.productGroup.name}${d.advisor ? ` · ${d.advisor.name}` : ""}`}
        actions={
          (draft || d.effectiveStatus === "sent") && (
            <button className="btn primary" disabled={!d.lines.length || send.isPending || !d.customer.email} onClick={() => send.mutate()} title={!d.customer.email ? "Klant heeft geen e-mailadres" : undefined}>
              {draft ? "Definitief maken en naar klant sturen" : "Opnieuw naar klant sturen"}
            </button>
          )
        }
      />
      <ErrorBox error={add.error ?? remove.error ?? send.error} />
      {send.data && <div className="alert info">Offerte gemaild naar {send.data.sentTo}{send.data.emailStatus !== "sent" && " (vastgelegd; e-mail niet verstuurd)"}. De klant accepteert via de link in de e-mail.</div>}
      <div className="row" style={{ marginBottom: 12 }}>
        <Badge s={d.effectiveStatus} />
        {d.validUntil && <span className="muted">Geldig tot {formatDate(d.validUntil)}</span>}
        {d.acceptedAt && <span className="muted">Geaccepteerd door {d.acceptedByName} op {formatDate(d.acceptedAt)}</span>}
        {d.projectStatus && <span className="badge green">Project: {d.projectStatus.status}</span>}
      </div>
      <div className="card flush">
        <table>
          <thead><tr><th>Omschrijving</th><th className="num">Aantal</th><th className="num">Prijs</th><th className="num">Btw</th><th className="num">Bedrag</th>{draft && <th />}</tr></thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td className="num">{formatQty(l.quantity)}</td>
                <td className="num">{formatCents(l.unitPriceCents)}</td>
                <td className="num">{formatPercent(l.vatRateBasisPoints)}</td>
                <td className="num">{formatCents(l.lineTotalCents)}</td>
                {draft && <td><button className="btn small danger" onClick={() => remove.mutate(l.id)}>✕</button></td>}
              </tr>
            ))}
            {!d.lines.length && <tr><td colSpan={6} className="muted">Nog geen regels. Voeg hieronder een pakket toe.</td></tr>}
          </tbody>
        </table>
        <dl className="kv print-totals" style={{ padding: "0 20px 16px" }}>
          <dt>Totaal excl. btw</dt><dd>{formatCents(d.totals.subtotalCents)}</dd>
          <dt>Btw</dt><dd>{formatCents(d.totals.vatCents)}</dd>
          <dt><strong>Totaal incl. btw</strong></dt><dd><strong>{formatCents(d.totals.totalCents)}</strong></dd>
        </dl>
      </div>
      {draft && (
        <div className="card row" style={{ alignItems: "flex-end" }}>
          <Field label="Product toevoegen">
            <select value={productId} onChange={(e) => setProductId(e.target.value)} style={{ minWidth: 320 }}>
              <option value="">Kies…</option>
              {catalog.data?.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name} ({formatCents(p.priceCents)} excl. btw)</option>)}
            </select>
          </Field>
          <Field label="Aantal"><input value={qty} onChange={(e) => setQty(e.target.value)} style={{ width: 80 }} /></Field>
          <button className="btn" disabled={!productId || add.isPending} onClick={() => add.mutate()} style={{ marginBottom: 12 }}>Toevoegen</button>
        </div>
      )}
    </>
  );
}

function SalesCustomers() {
  const [q, setQ] = useState("");
  const list = useQuery({ queryKey: ["sales-customers", q], queryFn: () => api.get<SalesCustomer[]>(`/sales/customers?q=${encodeURIComponent(q)}`) });
  return (
    <>
      <PageHead title="Klanten" sub="Klanten die u heeft aangebracht." />
      <div className="card"><input placeholder="Zoeken op naam of e-mail" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%" }} /></div>
      <div className="card flush">
        {!list.data?.length ? <div className="empty">Geen klanten.</div> : (
          <table>
            <thead><tr><th>Nr.</th><th>Naam</th><th>Adres</th><th>E-mail</th></tr></thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.displayNumber}</td>
                  <td>{[c.firstName, c.lastName].filter(Boolean).join(" ")}</td>
                  <td>{c.properties[0] && `${c.properties[0].street} ${c.properties[0].houseNumber}, ${c.properties[0].city}`}</td>
                  <td>{c.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function SalesFees() {
  const fees = useQuery({
    queryKey: ["sales-fees"],
    queryFn: () => api.get<{ open: { description: string; advisorName: string | null; basisCents: number | null; feeBasisPoints: number | null; amountCents: number | null; missing: string | null }[]; invoices: { id: string; number: string; invoiceDate: string; totalCents: number; status: string; approvalStatus: string | null; paidAt: string | null }[] }>("/sales/fees"),
  });
  if (!fees.data) return <Loading />;
  return (
    <>
      <PageHead title="Mijn fee" sub="Fee wordt uitbetaalbaar zodra de klant de aanbetaling heeft voldaan. Gecko maakt de factuur namens u op; u krijgt die per e-mail ter akkoord." />
      <div className="card flush">
        <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>Nog uit te betalen</h2></div>
        {!fees.data.open.length ? <div className="empty">Niets openstaand.</div> : (
          <table>
            <thead><tr><th>Project / offerte</th><th>Adviseur</th><th className="num">Grondslag</th><th className="num">Fee</th><th className="num">Bedrag</th></tr></thead>
            <tbody>
              {fees.data.open.map((i, n) => (
                <tr key={n}>
                  <td>{i.description}{i.missing && <div className="muted" style={{ fontSize: 12 }}>Wacht op Gecko: fee-percentage nog niet ingesteld</div>}</td>
                  <td>{i.advisorName ?? "—"}</td>
                  <td className="num">{formatCents(i.basisCents)}</td>
                  <td className="num">{i.feeBasisPoints != null ? formatPercent(i.feeBasisPoints) : "—"}</td>
                  <td className="num">{formatCents(i.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {fees.data.invoices.length > 0 && (
        <div className="card flush">
          <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>Facturen</h2></div>
          <table>
            <thead><tr><th>Nummer</th><th>Datum</th><th className="num">Totaal</th><th>Status</th></tr></thead>
            <tbody>
              {fees.data.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="mono">{i.number}</td>
                  <td>{formatDate(i.invoiceDate)}</td>
                  <td className="num">{formatCents(i.totalCents)}</td>
                  <td>{i.status === "paid" ? <span className="badge green">Betaald {formatDate(i.paidAt)}</span> : i.approvalStatus === "approved" ? <span className="badge yellow">Akkoord, wordt betaald</span> : i.approvalStatus === "disputed" ? <span className="badge red">Niet akkoord</span> : <span className="badge">Wacht op uw akkoord (zie e-mail)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
