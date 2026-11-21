import { OwnPhotoButton } from "./components/Specialist";
import { SpecialistsPage } from "./pages/Specialists";
import { PasskeyPrompt, PasskeysButton, shouldPromptPasskey } from "./components/Passkeys";
import { Avatar } from "./components/Avatar";
import { NavIcon } from "./components/icons";
import { Toaster } from "./components/Toast";
import { AccountActivatePage } from "./pages/AccountActivate";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useState, useEffect } from "react";
import { useAuth } from "./auth";
import { ChangePasswordModal } from "./components/ChangePassword";
import { ImpersonationBar } from "./components/ImpersonationBar";
import { TestModeBar } from "./components/TestModeBar";
import { TestingPage } from "./pages/Testing";
import { AuditPage } from "./pages/Audit";
import { ChannelsPage } from "./pages/Channels";
import { CustomerDetailPage } from "./pages/CustomerDetail";
import { CustomersPage } from "./pages/Customers";
import { JourneysPage } from "./pages/Journeys";
import { MessagesPage } from "./pages/Messages";
import { WorkPage } from "./pages/Work";
import { HelpPage } from "./pages/Help";
import { InboxPage } from "./pages/Inbox";
import { SalesApp } from "./sales/SalesApp";
import { GlobalSearch } from "./components/GlobalSearch";
import { NotificationBell } from "./components/Notifications";
import { CustomerPortalPage, PortalRedeemPage } from "./pages/CustomerPortal";
import { ChecklistsPage } from "./pages/Checklists";
import { ReportsPage } from "./pages/Reports";
import { PublicSelfBillingPage, SelfBillingDetailPage, SelfBillingPage, SelfBillingPrintPage } from "./pages/SelfBilling";
import { ProjectDetailPage } from "./pages/ProjectDetail";
import { ProjectsPage } from "./pages/Projects";
import { QuoteDetailPage } from "./pages/QuoteDetail";
import { QuotePrintPage } from "./pages/QuotePrint";
import { QuotesPage } from "./pages/Quotes";
import { PublicQuotePage } from "./pages/PublicQuote";
import { InvoiceDetailPage } from "./pages/InvoiceDetail";
import { InvoicePrintPage } from "./pages/InvoicePrint";
import { InvoicesPage } from "./pages/Invoices";
import { PublicInvoicePage } from "./pages/PublicInvoice";
import { SettingsPage } from "./pages/Settings";
import { PartnerApp } from "./partner/PartnerApp";
import { PlanningPage } from "./pages/Planning";
import { AvailabilityPage, RegionsPage } from "./pages/Regions";
import { ReportReviewPage } from "./pages/ReportReview";
import { TestPaymentPage } from "./pages/TestPayment";
import { LoginPage } from "./pages/Login";
import { OrganizationsPage } from "./pages/Organizations";
import { ProductDetailPage } from "./pages/ProductDetail";
import { ProductsPage } from "./pages/Products";
import { RolesPage } from "./pages/Roles";
import { UsersPage } from "./pages/Users";

export function App() {
  const { me, can, logout, refresh } = useAuth();
  const [changingPassword, setChangingPassword] = useState(false);
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  // Menu (telefoon) sluiten na elke navigatie.
  useEffect(() => setMenuOpen(false), [location.pathname]);
  // Na het inloggen Face ID laten instellen (eenmalig per sessie gevraagd, zie PasskeyPrompt).
  const [passkeyPrompt, setPasskeyPrompt] = useState<false | "first" | "device">(false);
  const ready = !!me && me.mfaVerified && !(me.mustChangePassword && !me.impersonatedBy);
  useEffect(() => {
    if (ready && me) setPasskeyPrompt(shouldPromptPasskey(me));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, me?.id, me?.hasPasskey]);
  // Klantpagina's zonder login
  if (/^\/(akkoord|factuur|testbetaling|selfbilling-akkoord|account-activeren|wachtwoord-herstellen)\//.test(location.pathname) || /^\/mijn(\/|$)/.test(location.pathname)) {
    return (
      <Routes>
        <Route path="/mijn" element={<CustomerPortalPage />} />
        <Route path="/mijn/inloggen/:token" element={<PortalRedeemPage />} />
        <Route path="/selfbilling-akkoord/:token" element={<PublicSelfBillingPage />} />
        <Route path="/account-activeren/:token" element={<AccountActivatePage />} />
        <Route path="/wachtwoord-herstellen/:token" element={<AccountActivatePage />} />
        <Route path="/akkoord/:token" element={<PublicQuotePage />} />
        <Route path="/factuur/:token" element={<PublicInvoicePage />} />
        <Route path="/testbetaling/:id" element={<TestPaymentPage />} />
      </Routes>
    );
  }
  if (!me || !me.mfaVerified || (me.mustChangePassword && !me.impersonatedBy)) return <LoginPage />;
  if (passkeyPrompt) return <PasskeyPrompt userId={me.id} kind={passkeyPrompt} onDone={async () => { setPasskeyPrompt(false); await refresh(); }} />;
  if (me.organizationType === "sales_partner") {
    return (
      <>
        <TestModeBar />
        <ImpersonationBar />
        <SalesApp />
        <Toaster />
      </>
    );
  }
  if (me.organizationType === "installation_partner") {
    if (/^\/uitbetalingen\/[^/]+\/print$/.test(location.pathname)) {
      return (
        <Routes>
          <Route path="/uitbetalingen/:id/print" element={<SelfBillingPrintPage path="/partner/selfbilling" />} />
        </Routes>
      );
    }
    return (
      <>
        <TestModeBar />
        <ImpersonationBar />
        <PartnerApp />
        <Toaster />
      </>
    );
  }
  if (/^\/(offertes|facturen|selfbilling)\/[^/]+\/print$/.test(location.pathname)) {
    return (
      <Routes>
        <Route path="/selfbilling/:id/print" element={<SelfBillingPrintPage />} />
        <Route path="/offertes/:id/print" element={<QuotePrintPage />} />
        <Route path="/facturen/:id/print" element={<InvoicePrintPage />} />
      </Routes>
    );
  }

  return (
    <>
    <TestModeBar />
    <ImpersonationBar />
    <div className="shell">
      {/* Telefoon: bovenbalk met menuknop; het menu schuift van links in. */}
      <header className="mobile-top">
        <button className="icon-btn" aria-label="Menu openen" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
        <NavLink to="/werk" className="brand">
          <span className="brand-mark">G</span> Gecko CRM
        </NavLink>
        <NotificationBell placement="down" />
      </header>
      <div className={`drawer-backdrop ${menuOpen ? "open" : ""}`} onClick={() => setMenuOpen(false)} aria-hidden="true" />
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <button className="icon-btn drawer-close" aria-label="Menu sluiten" onClick={() => setMenuOpen(false)}>
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
        <div className="brand">
          <span className="brand-mark">G</span> Gecko CRM
        </div>
        <GlobalSearch />
        <nav className="nav">
          <div className="nav-section">Klanten</div>
          <NavLink to="/werk"><NavIcon name="werk" />Mijn werk</NavLink>
          {can("customers.read") && <NavLink to="/inbox"><NavIcon name="inbox" />Inbox</NavLink>}
          <NavLink to="/hulp"><NavIcon name="hulp" />Handleiding</NavLink>
          {can("customers.read") && <NavLink to="/klanten"><NavIcon name="klanten" />Klanten</NavLink>}
          {can("quotes.read") && <NavLink to="/offertes"><NavIcon name="offertes" />Offertes</NavLink>}
          {can("projects.read") && <NavLink to="/projecten"><NavIcon name="projecten" />Projecten</NavLink>}
          {can("planning.read") && <NavLink to="/planning"><NavIcon name="planning" />Planning</NavLink>}
          {can("invoices.read") && <NavLink to="/facturen"><NavIcon name="facturen" />Facturen</NavLink>}
          {can("invoices.read") && <NavLink to="/selfbilling"><NavIcon name="selfbilling" />Selfbilling</NavLink>}
          {can("projects.read") && <NavLink to="/rapportages"><NavIcon name="rapportages" />Rapportages</NavLink>}
          <div className="nav-section">Catalogus</div>
          {can("catalog.read") && <NavLink to="/producten"><NavIcon name="producten" />Producten</NavLink>}
          {can("catalog.read") && <NavLink to="/verkoopkanalen"><NavIcon name="kanalen" />Verkoopkanalen</NavLink>}
          <div className="nav-section">Beheer</div>
          {can("organizations.read") && <NavLink to="/organisaties"><NavIcon name="organisaties" />Organisaties</NavLink>}
          {can("projects.read") && <NavLink to="/klantreizen"><NavIcon name="reizen" />Klantreizen</NavLink>}
          {can("projects.read") && <NavLink to="/klantberichten"><NavIcon name="berichten" />Klantberichten</NavLink>}
          {can("planning.read") && <NavLink to="/checklists"><NavIcon name="checklists" />Checklists</NavLink>}
          {can("planning.read") && <NavLink to="/regios"><NavIcon name="regios" />Regio's</NavLink>}
          {can("planning.read") && <NavLink to="/beschikbaarheid"><NavIcon name="beschikbaarheid" />Beschikbaarheid</NavLink>}
          {can("specialists.manage") && <NavLink to="/klantspecialisten"><NavIcon name="klanten" />Klantspecialisten</NavLink>}
          {can("users.read") && <NavLink to="/gebruikers"><NavIcon name="gebruikers" />Gebruikers</NavLink>}
          {can("users.read") && <NavLink to="/rollen"><NavIcon name="rollen" />Rollen &amp; rechten</NavLink>}
          {can("audit.read") && <NavLink to="/logboek"><NavIcon name="logboek" />Logboek</NavLink>}
          {can("settings.manage") && <NavLink to="/instellingen"><NavIcon name="instellingen" />Instellingen</NavLink>}
          {can("settings.manage") && <NavLink to="/testen"><NavIcon name="testen" />Testen</NavLink>}
        </nav>
        <div className="sidebar-footer">
          <div className="me-row">
            <Avatar name={me.name} size={32} />
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "var(--text)", fontWeight: 500 }}>{me.name}</div>
              <div className="ellipsis">{me.email ?? me.username}</div>
            </div>
          </div>
          <NotificationBell />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => setChangingPassword(true)}>Wachtwoord</button>
            <PasskeysButton />
            {can("customers.read") && !can("customers.all") && <OwnPhotoButton />}
            <button className="btn small" onClick={logout}>Uitloggen</button>
          </div>
        </div>
      </aside>
      <nav className="mobile-tabs" aria-label="Snelmenu">
        <NavLink to="/werk"><TabIcon d="M3 10l7-6 7 6v7H3z" />Mijn werk</NavLink>
        {can("customers.read") && <NavLink to="/klanten"><TabIcon d="M7 9a3 3 0 100-6 3 3 0 000 6zm-5 8c0-3 2-5 5-5s5 2 5 5M13 4a3 3 0 010 5.5M18 17c0-2.5-1.3-4.3-3.5-4.9" />Klanten</NavLink>}
        {can("planning.read") && <NavLink to="/planning"><TabIcon d="M3 5h14v12H3zM3 8h14M7 3v4M13 3v4" />Planning</NavLink>}
        {can("quotes.read") && <NavLink to="/offertes"><TabIcon d="M5 2h7l4 4v12H5zM12 2v4h4M8 10h5M8 13h5" />Offertes</NavLink>}
        <button type="button" onClick={() => setMenuOpen(true)}><TabIcon d="M3 5h14M3 10h14M3 15h14" />Menu</button>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/werk" replace />} />
          <Route path="/werk" element={<WorkPage />} />
          <Route path="/hulp" element={<HelpPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/klanten" element={<CustomersPage />} />
          <Route path="/klanten/:id" element={<CustomerDetailPage />} />
          <Route path="/projecten" element={<ProjectsPage />} />
          <Route path="/projecten/:id" element={<ProjectDetailPage />} />
          <Route path="/klantreizen" element={<JourneysPage />} />
          <Route path="/klantberichten" element={<MessagesPage />} />
          <Route path="/checklists" element={<ChecklistsPage />} />
          <Route path="/offertes" element={<QuotesPage />} />
          <Route path="/facturen" element={<InvoicesPage />} />
          <Route path="/facturen/:id" element={<InvoiceDetailPage />} />
          <Route path="/selfbilling" element={<SelfBillingPage />} />
          <Route path="/rapportages" element={<ReportsPage />} />
          <Route path="/selfbilling/:id" element={<SelfBillingDetailPage />} />
          <Route path="/instellingen" element={<SettingsPage />} />
          <Route path="/planning" element={<PlanningPage />} />
          <Route path="/testen" element={<TestingPage />} />
          <Route path="/rapporten/:id" element={<ReportReviewPage />} />
          <Route path="/regios" element={<RegionsPage />} />
          <Route path="/beschikbaarheid" element={<AvailabilityPage />} />
          <Route path="/offertes/:id" element={<QuoteDetailPage />} />
          <Route path="/producten" element={<ProductsPage />} />
          <Route path="/producten/:id" element={<ProductDetailPage />} />
          <Route path="/verkoopkanalen" element={<ChannelsPage />} />
          <Route path="/organisaties" element={<OrganizationsPage />} />
          <Route path="/gebruikers" element={<UsersPage />} />
          <Route path="/klantspecialisten" element={<SpecialistsPage />} />
          <Route path="/rollen" element={<RolesPage />} />
          <Route path="/logboek" element={<AuditPage />} />
          <Route path="*" element={<div className="empty">Pagina niet gevonden</div>} />
        </Routes>
      </main>
      {changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />}
      <Toaster />
    </div>
    </>
  );
}

/** Klein lijnicoon voor de onderbalk op de telefoon. */
function TabIcon({ d }: { d: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
