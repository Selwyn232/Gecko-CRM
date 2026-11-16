import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "./auth";
import { ChangePasswordModal } from "./components/ChangePassword";
import { AuditPage } from "./pages/Audit";
import { ChannelsPage } from "./pages/Channels";
import { LoginPage } from "./pages/Login";
import { OrganizationsPage } from "./pages/Organizations";
import { ProductDetailPage } from "./pages/ProductDetail";
import { ProductsPage } from "./pages/Products";
import { RolesPage } from "./pages/Roles";
import { UsersPage } from "./pages/Users";

export function App() {
  const { me, can, logout } = useAuth();
  const [changingPassword, setChangingPassword] = useState(false);
  if (!me || !me.mfaVerified) return <LoginPage />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">G</span> Gecko CRM
        </div>
        <nav className="nav">
          <div className="nav-section">Catalogus</div>
          {can("catalog.read") && <NavLink to="/producten">Producten</NavLink>}
          {can("catalog.read") && <NavLink to="/verkoopkanalen">Verkoopkanalen</NavLink>}
          <div className="nav-section">Beheer</div>
          {can("organizations.read") && <NavLink to="/organisaties">Organisaties</NavLink>}
          {can("users.read") && <NavLink to="/gebruikers">Gebruikers</NavLink>}
          {can("users.read") && <NavLink to="/rollen">Rollen &amp; rechten</NavLink>}
          {can("audit.read") && <NavLink to="/logboek">Logboek</NavLink>}
        </nav>
        <div className="sidebar-footer">
          <div style={{ color: "var(--text)", fontWeight: 500 }}>{me.name}</div>
          <div>{me.email}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={() => setChangingPassword(true)}>Wachtwoord</button>
            <button className="btn small" onClick={logout}>Uitloggen</button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/producten" replace />} />
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
