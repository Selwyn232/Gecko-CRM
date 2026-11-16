import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "./auth";
import { ChangePasswordModal } from "./components/ChangePassword";
import { AuditPage } from "./pages/Audit";
import { ChannelsPage } from "./pages/Channels";
import { CustomerDetailPage } from "./pages/CustomerDetail";
import { CustomersPage } from "./pages/Customers";
import { JourneysPage } from "./pages/Journeys";
import { ProjectDetailPage } from "./pages/ProjectDetail";
import { ProjectsPage } from "./pages/Projects";
import { QuoteDetailPage } from "./pages/QuoteDetail";
import { QuotePrintPage } from "./pages/QuotePrint";
import { QuotesPage } from "./pages/Quotes";
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
  if (!me || !me.mfaVerified || me.mustChangePassword) return <LoginPage />;
  if (/^\/offertes\/[^/]+\/print$/.test(location.pathname)) {
    return (
      <Routes>
        <Route path="/offertes/:id/print" element={<QuotePrintPage />} />
      </Routes>
    );
  }

  return (
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
          <div className="nav-section">Catalogus</div>
          {can("catalog.read") && <NavLink to="/producten">Producten</NavLink>}
          {can("catalog.read") && <NavLink to="/verkoopkanalen">Verkoopkanalen</NavLink>}
          <div className="nav-section">Beheer</div>
          {can("organizations.read") && <NavLink to="/organisaties">Organisaties</NavLink>}
          {can("projects.read") && <NavLink to="/klantreizen">Klantreizen</NavLink>}
          {can("users.read") && <NavLink to="/gebruikers">Gebruikers</NavLink>}
          {can("users.read") && <NavLink to="/rollen">Rollen &amp; rechten</NavLink>}
          {can("audit.read") && <NavLink to="/logboek">Logboek</NavLink>}
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
          <Route path="/offertes" element={<QuotesPage />} />
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
  );
}
