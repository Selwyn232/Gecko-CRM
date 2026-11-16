import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useState } from "react";
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
  const { me, can, logout } = useAuth();
  const [changingPassword, setChangingPassword] = useState(false);
  const location = useLocation();
  // Klantpagina's zonder login
  if (/^\/(akkoord|factuur|testbetaling|selfbilling-akkoord)\//.test(location.pathname) || /^\/mijn(\/|$)/.test(location.pathname)) {
    return (
      <Routes>
        <Route path="/mijn" element={<CustomerPortalPage />} />
        <Route path="/mijn/inloggen/:token" element={<PortalRedeemPage />} />
        <Route path="/selfbilling-akkoord/:token" element={<PublicSelfBillingPage />} />
        <Route path="/akkoord/:token" element={<PublicQuotePage />} />
        <Route path="/factuur/:token" element={<PublicInvoicePage />} />
        <Route path="/testbetaling/:id" element={<TestPaymentPage />} />
      </Routes>
    );
  }
  if (!me || !me.mfaVerified || (me.mustChangePassword && !me.impersonatedBy)) return <LoginPage />;
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
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">G</span> Gecko CRM
        </div>
        <nav className="nav">
          <div className="nav-section">Klanten</div>
          {can("customers.read") && <NavLink to="/klanten">Klanten</NavLink>}
          {can("quotes.read") && <NavLink to="/offertes">Offertes</NavLink>}
          {can("projects.read") && <NavLink to="/projecten">Projecten</NavLink>}
          {can("planning.read") && <NavLink to="/planning">Planning</NavLink>}
          {can("invoices.read") && <NavLink to="/facturen">Facturen</NavLink>}
          {can("invoices.read") && <NavLink to="/selfbilling">Selfbilling</NavLink>}
          {can("projects.read") && <NavLink to="/rapportages">Rapportages</NavLink>}
          <div className="nav-section">Catalogus</div>
          {can("catalog.read") && <NavLink to="/producten">Producten</NavLink>}
          {can("catalog.read") && <NavLink to="/verkoopkanalen">Verkoopkanalen</NavLink>}
          <div className="nav-section">Beheer</div>
          {can("organizations.read") && <NavLink to="/organisaties">Organisaties</NavLink>}
          {can("projects.read") && <NavLink to="/klantreizen">Klantreizen</NavLink>}
          {can("projects.read") && <NavLink to="/klantberichten">Klantberichten</NavLink>}
          {can("planning.read") && <NavLink to="/checklists">Checklists</NavLink>}
          {can("planning.read") && <NavLink to="/regios">Regio's</NavLink>}
          {can("planning.read") && <NavLink to="/beschikbaarheid">Beschikbaarheid</NavLink>}
          {can("users.read") && <NavLink to="/gebruikers">Gebruikers</NavLink>}
          {can("users.read") && <NavLink to="/rollen">Rollen &amp; rechten</NavLink>}
          {can("audit.read") && <NavLink to="/logboek">Logboek</NavLink>}
          {can("settings.manage") && <NavLink to="/instellingen">Instellingen</NavLink>}
          {can("settings.manage") && <NavLink to="/testen">Testen</NavLink>}
        </nav>
        <div className="sidebar-footer">
          <div style={{ color: "var(--text)", fontWeight: 500 }}>{me.name}</div>
          <div>{me.username ?? me.email}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => setChangingPassword(true)}>Wachtwoord</button>
            <button className="btn small" onClick={logout}>Uitloggen</button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to={can("projects.read") ? "/projecten" : "/producten"} replace />} />
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
          <Route path="/rollen" element={<RolesPage />} />
          <Route path="/logboek" element={<AuditPage />} />
          <Route path="*" element={<div className="empty">Pagina niet gevonden</div>} />
        </Routes>
      </main>
      {changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />}
    </div>
    </>
  );
}
