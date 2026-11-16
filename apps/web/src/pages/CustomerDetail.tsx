import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type InvoiceSummary, type CustomerDetail, type ProjectDetail, type Quote, type QuoteListItem } from "../api";
import { QuotesTable } from "./Quotes";
import { InvoicesTable } from "./Invoices";
import { useAuth } from "../auth";
import { CustomerMargins } from "../components/Calculation";
import { CustomerTimeline } from "../components/Timeline";
import { ErrorBox, Field, Loading, Modal, StatusPill } from "../components/ui";
import { customerName, formatAddress, formatDate, formatDateTime, PAYMENT_METHODS } from "../format";
import { nameById, useAdvisors, useChannels, useOrganizations, useProductGroups } from "../hooks";
import { AddressFields, CustomerForm } from "./Customers";

export function CustomerDetailPage() {
  const { id } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const groups = useProductGroups();
  const channels = useChannels();
  const [editing, setEditing] = useState(false);
  const [addingProperty, setAddingProperty] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [addingQuote, setAddingQuote] = useState(false);
  const customer = useQuery({ queryKey: ["customer", id], queryFn: () => api.get<CustomerDetail>(`/customers/${id}`) });
  const invoices = useQuery({
    queryKey: ["invoices", "customer", id],
    queryFn: () => api.get<InvoiceSummary[]>(`/invoices?customerId=${id}`),
    enabled: can("invoices.read"),
  });
  const quotes = useQuery({
    queryKey: ["quotes", "customer", id],
    queryFn: () => api.get<QuoteListItem[]>(`/quotes?customerId=${id}`),
    enabled: can("quotes.read"),
  });

  if (customer.isLoading) return <Loading />;
  if (!customer.data) return <ErrorBox error={customer.error ?? "Niet gevonden"} />;
  const c = customer.data;

  return (
    <>
      <div style={{ marginBottom: 8 }}><Link to="/klanten">← Klanten</Link></div>
      <div className="page-head">
        <div>
          <h1>{customerName(c)}</h1>
          <p className="row"><span className="mono">{c.displayNumber}</span>{c.salesChannelId && <span className="badge">{nameById(channels.data, c.salesChannelId)}</span>}</p>
        </div>
        <div className="row">
          {can("customers.manage") && c.email && <PortalInvite customerId={c.id} />}
          {can("customers.manage") && <button className="btn" onClick={() => setEditing(true)}>Wijzigen</button>}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Contact</h2>
          <dl className="kv">
            <dt>E-mail</dt><dd>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : "—"}</dd>
            <dt>Telefoon</dt><dd>{c.phone ? <a href={`tel:${c.phone}`}>{c.phone}</a> : "—"}</dd>
            <dt>Klant sinds</dt><dd>{formatDate(c.createdAt)}</dd>
          </dl>
          {c.notes && <p style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>{c.notes}</p>}
        </div>
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Woningen</h2>
            {can("customers.manage") && <button className="btn small" onClick={() => setAddingProperty(true)}>+ Woning</button>}
          </div>
          {c.properties.map((p) => <div key={p.id} style={{ padding: "6px 0" }}>{formatAddress(p)}</div>)}
        </div>
      </div>

      <div className="card flush">
        <div className="row" style={{ justifyContent: "space-between", padding: "16px 20px 8px" }}>
          <h2 style={{ margin: 0 }}>Projecten</h2>
          {can("projects.manage") && <button className="btn primary small" onClick={() => setAddingProject(true)}>Nieuw project</button>}
        </div>
        {!c.projects.length ? <div className="empty">Nog geen projecten.</div> : (
          <table>
            <thead><tr><th>Nr.</th><th>Productgroep</th><th>Woning</th><th>Status</th><th>Betaling</th><th>Aangemaakt</th></tr></thead>
            <tbody>
              {c.projects.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/projecten/${p.id}`)}>
                  <td className="mono">{p.displayNumber}</td>
                  <td>{nameById(groups.data, p.productGroupId)}</td>
                  <td>{formatAddress(c.properties.find((x) => x.id === p.propertyId)!)}</td>
                  <td><StatusPill status={p.status} /></td>
                  <td>{PAYMENT_METHODS[p.paymentMethod]}</td>
                  <td className="muted">{formatDate(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {can("quotes.read") && (
        <div className="card flush">
          <div className="row" style={{ justifyContent: "space-between", padding: "16px 20px 8px" }}>
            <h2 style={{ margin: 0 }}>Offertes</h2>
            {can("quotes.manage") && <button className="btn primary small" onClick={() => setAddingQuote(true)}>Nieuwe offerte</button>}
          </div>
          {!quotes.data?.length ? <div className="empty">Nog geen offertes.</div> : <QuotesTable items={quotes.data} showCustomer={false} />}
        </div>
      )}
      {can("invoices.read") && invoices.data && invoices.data.length > 0 && (
        <div className="card flush">
          <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>Facturen</h2></div>
          <InvoicesTable items={invoices.data} showCustomer={false} />
        </div>
      )}
      {can("purchase_prices.read") && <CustomerMargins projects={c.projects} />}
      <CustomerTimeline customerId={c.id} projects={c.projects} />
      <CustomerEmails customerId={c.id} />

      {editing && <CustomerForm customer={c} onClose={() => setEditing(false)} />}
      {addingProperty && <PropertyForm customerId={c.id} onClose={() => setAddingProperty(false)} />}
      {addingQuote && <QuoteForm customer={c} onClose={() => setAddingQuote(false)} onSaved={(q) => navigate(`/offertes/${q.id}`)} />}
      {addingProject && <ProjectForm customer={c} onClose={() => setAddingProject(false)} onSaved={(p) => navigate(`/projecten/${p.id}`)} />}
    </>
  );
}

const EMAIL_KINDS: Record<string, string> = {
  "quote.link": "Offerte",
  "quote.code": "Bevestigingscode offerte",
  "quote.accepted": "Bevestiging opdracht",
  "invoice.deposit": "Aanbetalingsfactuur",
  "invoice.final": "Eindfactuur",
  "invoice.credit": "Creditnota",
  "portal.login": "Inloglink Mijn Gecko",
  "project.status": "Statusbericht",
  "appointment.scheduled": "Afspraak ingepland",
  "appointment.scheduled.survey": "Schouw ingepland",
  "appointment.scheduled.installation": "Installatie ingepland",
  "appointment.canceled": "Afspraak geannuleerd",
  "appointment.reminder.survey": "Herinnering schouw",
  "appointment.reminder.installation": "Herinnering installatie",
};
const EMAIL_STATUS: Record<string, { label: string; cls: string }> = {
  sent: { label: "Verstuurd", cls: "green" },
  queued: { label: "In de wachtrij", cls: "yellow" },
  failed: { label: "Mislukt", cls: "red" },
  not_sent: { label: "Niet verstuurd", cls: "" },
};
interface CustomerEmail { id: string; toAddress: string; subject: string; text: string; template: string; status: string; error: string | null; createdAt: string }

/** Inloglink voor Mijn Gecko naar de klant sturen. */
function PortalInvite({ customerId }: { customerId: string }) {
  const qc = useQueryClient();
  const invite = useMutation({
    mutationFn: () => api.post<{ sentTo: string }>(`/customers/${customerId}/portal-invite`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customer-emails", customerId] }),
  });
  return invite.isSuccess ? (
    <span className="badge green">Uitnodiging Mijn Gecko verstuurd</span>
  ) : (
    <button className="btn" disabled={invite.isPending} title={invite.error ? String((invite.error as Error).message) : "Klant krijgt een inloglink voor Mijn Gecko"} onClick={() => invite.mutate()}>
      Uitnodigen voor Mijn Gecko
    </button>
  );
}

/** Alle e-mails aan deze klant; klik op een regel voor de tekst. */
function CustomerEmails({ customerId }: { customerId: string }) {
  const emails = useQuery({ queryKey: ["customer-emails", customerId], queryFn: () => api.get<CustomerEmail[]>(`/customers/${customerId}/emails`) });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="card flush">
      <div style={{ padding: "16px 20px 8px" }}><h2 style={{ margin: 0 }}>E-mails</h2></div>
      {!emails.data?.length ? <div className="empty">Nog geen e-mails verstuurd.</div> : (
        <table>
          <thead><tr><th>Datum</th><th>Soort</th><th>Onderwerp</th><th>Aan</th><th>Status</th></tr></thead>
          <tbody>
            {emails.data.map((e) => {
              const st = EMAIL_STATUS[e.status] ?? { label: e.status, cls: "" };
              return (
                <Fragment key={e.id}>
                  <tr className="clickable" onClick={() => setOpen(open === e.id ? null : e.id)}>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>{formatDateTime(e.createdAt)}</td>
                    <td style={{ fontSize: 13 }}>{EMAIL_KINDS[e.template] ?? (e.template.startsWith("invoice") || e.template.startsWith("dunning") ? "Factuur / betaling" : e.template)}</td>
                    <td>{e.subject}</td>
                    <td style={{ fontSize: 13 }}>{e.toAddress}</td>
                    <td><span className={`badge ${st.cls}`} title={e.error ?? undefined}>{st.label}</span></td>
                  </tr>
                  {open === e.id && (
                    <tr><td colSpan={5} style={{ whiteSpace: "pre-wrap", fontSize: 13, background: "var(--surface-2)" }}>{e.text}{e.error && <div className="alert error" style={{ marginTop: 8 }}>{e.error}</div>}</td></tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PropertyForm({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [address, setAddress] = useState({ street: "", houseNumber: "", houseNumberAddition: "", postalCode: "", city: "" });
  const save = useMutation({
    mutationFn: () => api.post(`/customers/${customerId}/properties`, { ...address, houseNumberAddition: address.houseNumberAddition || null }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["customer", customerId] });
      onClose();
    },
  });
  return (
    <Modal title="Woning toevoegen" onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <ErrorBox error={save.error} />
        <AddressFields value={address} onChange={setAddress} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Annuleren</button>
          <button className="btn primary">Opslaan</button>
        </div>
      </form>
    </Modal>
  );
}

function ProjectForm({ customer, onClose, onSaved }: { customer: CustomerDetail; onClose: () => void; onSaved: (p: ProjectDetail) => void }) {
  const qc = useQueryClient();
  const groups = useProductGroups();
  const channels = useChannels();
  const orgs = useOrganizations();
  const [form, setForm] = useState({
    propertyId: customer.properties[0]?.id ?? "",
    productGroupId: "",
    salesChannelId: customer.salesChannelId ?? "",
    installationPartnerId: "",
    paymentMethod: "direct",
  });
  const channel = channels.data?.find((c) => c.id === form.salesChannelId);
  const allowedGroups = (groups.data ?? []).filter((g) => !channel || channel.productGroupIds.includes(g.id));
  const save = useMutation({
    mutationFn: () => api.post<ProjectDetail>("/projects", { ...form, customerId: customer.id, installationPartnerId: form.installationPartnerId || null }),
    onSuccess: async (p) => {
      await qc.invalidateQueries({ queryKey: ["customer", customer.id] });
      await qc.invalidateQueries({ queryKey: ["projects"] });
      onSaved(p);
    },
  });
  return (
    <Modal title="Nieuw project" onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <ErrorBox error={save.error} />
        <p className="muted" style={{ fontSize: 13 }}>Eén project per productgroep. Koopt de klant meerdere productgroepen, maak dan meerdere projecten aan.</p>
        <Field label="Woning">
          <select value={form.propertyId} onChange={(e) => setForm({ ...form, propertyId: e.target.value })} required>
            {customer.properties.map((p) => <option key={p.id} value={p.id}>{formatAddress(p)}</option>)}
          </select>
        </Field>
        <div className="grid-2">
          <Field label="Verkoopkanaal">
            <select value={form.salesChannelId} onChange={(e) => setForm({ ...form, salesChannelId: e.target.value, productGroupId: "" })} required>
              <option value="">Kies…</option>
              {channels.data?.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Productgroep">
            <select value={form.productGroupId} onChange={(e) => setForm({ ...form, productGroupId: e.target.value })} required>
              <option value="">Kies…</option>
              {allowedGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
          <Field label="Installatiepartner">
            <select value={form.installationPartnerId} onChange={(e) => setForm({ ...form, installationPartnerId: e.target.value })}>
              <option value="">Nog niet bekend</option>
              {orgs.data?.filter((o) => o.type === "installation_partner" && o.isActive).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </Field>
          <Field label="Betaalwijze">
            <select value={form.paymentMethod} onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}>
              {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Annuleren</button>
          <button className="btn primary" disabled={save.isPending}>Aanmaken</button>
        </div>
      </form>
    </Modal>
  );
}

function QuoteForm({ customer, onClose, onSaved }: { customer: CustomerDetail; onClose: () => void; onSaved: (q: Quote) => void }) {
  const qc = useQueryClient();
  const groups = useProductGroups();
  const channels = useChannels();
  const orgs = useOrganizations();
  const [form, setForm] = useState({
    propertyId: customer.properties[0]?.id ?? "",
    salesChannelId: customer.salesChannelId ?? "",
    productGroupId: "",
    advisorId: "",
    installationPartnerId: "",
  });
  const channel = channels.data?.find((c) => c.id === form.salesChannelId);
  const advisors = useAdvisors(channel?.salesPartnerOrganizationId ?? null);
  const save = useMutation({
    mutationFn: () =>
      api.post<Quote>("/quotes", { ...form, customerId: customer.id, advisorId: form.advisorId || null, installationPartnerId: form.installationPartnerId || null }),
    onSuccess: async (q) => {
      await qc.invalidateQueries({ queryKey: ["quotes"] });
      onSaved(q);
    },
  });
  return (
    <Modal title="Nieuwe offerte" onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <ErrorBox error={save.error} />
        <p className="muted" style={{ fontSize: 13 }}>Eén offerte per productgroep. Na akkoord wordt het project automatisch aangemaakt.</p>
        <Field label="Woning">
          <select value={form.propertyId} onChange={(e) => setForm({ ...form, propertyId: e.target.value })} required>
            {customer.properties.map((p) => <option key={p.id} value={p.id}>{formatAddress(p)}</option>)}
          </select>
        </Field>
        <div className="grid-2">
          <Field label="Verkoopkanaal">
            <select value={form.salesChannelId} onChange={(e) => setForm({ ...form, salesChannelId: e.target.value, productGroupId: "", advisorId: "" })} required>
              <option value="">Kies…</option>
              {channels.data?.filter((c) => c.isActive).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Productgroep">
            <select value={form.productGroupId} onChange={(e) => setForm({ ...form, productGroupId: e.target.value })} required>
              <option value="">Kies…</option>
              {(groups.data ?? []).filter((g) => !channel || channel.productGroupIds.includes(g.id)).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
          {channel?.salesPartnerOrganizationId && (
            <Field label="Adviseur">
              <select value={form.advisorId} onChange={(e) => setForm({ ...form, advisorId: e.target.value })}>
                <option value="">—</option>
                {advisors.data?.filter((a) => a.isActive).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Installatiepartner (voor kostprijs)">
            <select value={form.installationPartnerId} onChange={(e) => setForm({ ...form, installationPartnerId: e.target.value })}>
              <option value="">Nog niet bekend</option>
              {orgs.data?.filter((o) => o.type === "installation_partner" && o.isActive).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Annuleren</button>
          <button className="btn primary" disabled={save.isPending}>Offerte aanmaken</button>
        </div>
      </form>
    </Modal>
  );
}
