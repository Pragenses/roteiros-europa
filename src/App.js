import React, { useState, useEffect } from 'react';
import { auth } from './lib/firebase';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import Dashboard from './pages/Dashboard';
import Clients from './pages/Clients';
import Orders from './pages/Orders';
import OrderDetail from './pages/OrderDetail';
import Providers from './pages/Providers';
import Calendar from './pages/Calendar';
import Settings from './pages/Settings';

const COLORS = {
  primary: '#1a3a5c',
  accent: '#c8a84b',
  bg: '#f7f6f3',
  white: '#ffffff',
  border: '#e2ddd5',
  text: '#1a1a1a',
  muted: '#6b6560',
  success: '#2d6a4f',
  warning: '#854f0b',
  danger: '#7f1d1d',
  info: '#0c447c',
};

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: '◈' },
  { id: 'calendar', label: 'Calendar', icon: '◷' },
  { id: 'clients', label: 'Clients', icon: '◉' },
  { id: 'orders', label: 'Orders', icon: '◧' },
  { id: 'providers', label: 'Providers', icon: '◎' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState('dashboard');
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => { setUser(u); setLoading(false); });
    return unsub;
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setLoginError('Incorrect email or password.');
    }
  };

  const handleLogout = () => signOut(auth);

  const navigate = (p, data) => {
    setPage(p);
    if (data?.orderId) setSelectedOrder(data.orderId);
  };

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: COLORS.bg, fontFamily: 'Georgia, serif', color: COLORS.muted, fontSize: 16 }}>
      Loading...
    </div>
  );

  if (!user) return (
    <div style={{ minHeight: '100vh', background: COLORS.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Georgia, serif' }}>
      <div style={{ background: COLORS.white, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: '2.5rem 2rem', width: 340 }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: 13, letterSpacing: '0.15em', color: COLORS.accent, textTransform: 'uppercase', marginBottom: 6 }}>Orbis Europa DMC</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: COLORS.primary }}>Roteiros Europa</div>
          <div style={{ fontSize: 13, color: COLORS.muted, marginTop: 4 }}>Booking Platform</div>
        </div>
        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: COLORS.muted, display: 'block', marginBottom: 4 }}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              style={{ width: '100%', padding: '9px 12px', border: `1px solid ${COLORS.border}`, borderRadius: 7, fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 12, color: COLORS.muted, display: 'block', marginBottom: 4 }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
              style={{ width: '100%', padding: '9px 12px', border: `1px solid ${COLORS.border}`, borderRadius: 7, fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }} />
          </div>
          {loginError && <div style={{ fontSize: 13, color: COLORS.danger, marginBottom: 12 }}>{loginError}</div>}
          <button type="submit" style={{ width: '100%', padding: '10px', background: COLORS.primary, color: COLORS.white, border: 'none', borderRadius: 7, fontSize: 14, fontFamily: 'inherit', cursor: 'pointer', fontWeight: 500 }}>
            Sign in
          </button>
        </form>
      </div>
    </div>
  );

  const renderPage = () => {
    if (page === 'order-detail') return <OrderDetail orderId={selectedOrder} navigate={navigate} colors={COLORS} />;
    if (page === 'dashboard') return <Dashboard navigate={navigate} colors={COLORS} />;
    if (page === 'calendar') return <Calendar navigate={navigate} colors={COLORS} />;
    if (page === 'clients') return <Clients navigate={navigate} colors={COLORS} />;
    if (page === 'orders') return <Orders navigate={navigate} colors={COLORS} />;
    if (page === 'providers') return <Providers navigate={navigate} colors={COLORS} />;
    if (page === 'settings') return <Settings colors={COLORS} />;
    return <Dashboard navigate={navigate} colors={COLORS} />;
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: COLORS.bg, fontFamily: 'Georgia, serif' }}>
      <aside style={{ width: 220, background: COLORS.primary, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '1.5rem 1.25rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ fontSize: 11, letterSpacing: '0.15em', color: COLORS.accent, textTransform: 'uppercase', marginBottom: 4 }}>Orbis Europa DMC</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: COLORS.white }}>Roteiros Europa</div>
        </div>
        <nav style={{ flex: 1, padding: '1rem 0' }}>
          {NAV.map(n => (
            <button key={n.id} onClick={() => setPage(n.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 1.25rem', background: page === n.id ? 'rgba(200,168,75,0.15)' : 'transparent', border: 'none', borderLeft: page === n.id ? `3px solid ${COLORS.accent}` : '3px solid transparent', color: page === n.id ? COLORS.accent : 'rgba(255,255,255,0.65)', fontSize: 14, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
              <span style={{ fontSize: 16 }}>{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
        <div style={{ padding: '1rem 1.25rem', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div>
          <button onClick={handleLogout} style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>
            Sign out
          </button>
        </div>
      </aside>
      <main style={{ flex: 1, overflow: 'auto', padding: '2rem' }}>
        {renderPage()}
      </main>
    </div>
  );
}
