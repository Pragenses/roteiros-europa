import React, { useState, useEffect } from 'react';
import { auth } from './lib/firebase';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import Dashboard from './pages/Dashboard';
import Clients from './pages/Clients';
import Orders from './pages/Orders';
import OrderDetail from './pages/OrderDetail';
import Offers from './pages/Offers';
import OfferDetail from './pages/OfferDetail';
import OfferPrint from './pages/OfferPrint';
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
  { id: 'offers', label: 'Offers', icon: '◫' },
  { id: 'providers', label: 'Providers', icon: '◎' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState('dashboard');
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [selectedOffer, setSelectedOffer] = useState(null);
  const [navParams, setNavParams] = useState({});
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

  const ALLOWED_EMAILS = ['helena.maria.brito@gmail.com', 'filipdlask@gmail.com'];

  const handleGoogleLogin = async () => {
    setLoginError('');
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(auth, provider);
      if (!ALLOWED_EMAILS.includes(result.user.email)) {
        await signOut(auth);
        setLoginError('Přístup zamítnut. Tento účet nemá oprávnění.');
      }
    } catch (err) {
      setLoginError('Google přihlášení selhalo: ' + err.message);
    }
  };

  const handleLogout = () => signOut(auth);

  const navigate = (p, data) => {
    setPage(p);
    if (data?.orderId) setSelectedOrder(data.orderId);
    if (data?.offerId) setSelectedOffer(data.offerId);
    setNavParams(data || {});
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0' }}>
          <div style={{ flex: 1, height: 1, background: COLORS.border }} />
          <span style={{ fontSize: 12, color: COLORS.muted }}>nebo</span>
          <div style={{ flex: 1, height: 1, background: COLORS.border }} />
        </div>
        <button onClick={handleGoogleLogin} style={{ width: '100%', padding: '10px', background: COLORS.white, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 7, fontSize: 14, fontFamily: 'inherit', cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#4285F4" d="M44.5 20H24v8.5h11.7C34.3 33.1 29.8 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 7.9 2.9l6-6C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.7-8 19.7-20 0-1.3-.1-2.7-.2-4z"/></svg>
          Přihlásit se přes Google
        </button>
      </div>
    </div>
  );

  const renderPage = () => {
    if (page === 'order-detail') return <OrderDetail orderId={selectedOrder} navigate={navigate} colors={COLORS} />;
    if (page === 'offers') return <Offers navigate={navigate} colors={COLORS} />;
    if (page === 'offer-detail') return <OfferDetail offerId={selectedOffer} navigate={navigate} colors={COLORS} />;
    if (page === 'offer-print') return <OfferPrint offerId={selectedOffer} navigate={navigate} colors={COLORS} />;
    if (page === 'dashboard') return <Dashboard navigate={navigate} colors={COLORS} />;
    if (page === 'calendar') return <Calendar navigate={navigate} colors={COLORS} />;
    if (page === 'clients') return <Clients navigate={navigate} colors={COLORS} />;
    if (page === 'orders') return <Orders navigate={navigate} colors={COLORS} />;
    if (page === 'providers') return <Providers navigate={navigate} colors={COLORS} navParams={navParams} />;
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
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 1.25rem', background: (page === n.id || (n.id === 'offers' && (page === 'offer-detail' || page === 'offer-print')) || (n.id === 'orders' && page === 'order-detail')) ? 'rgba(200,168,75,0.15)' : 'transparent', border: 'none', borderLeft: (page === n.id || (n.id === 'offers' && (page === 'offer-detail' || page === 'offer-print')) || (n.id === 'orders' && page === 'order-detail')) ? `3px solid ${COLORS.accent}` : '3px solid transparent', color: (page === n.id || (n.id === 'offers' && (page === 'offer-detail' || page === 'offer-print')) || (n.id === 'orders' && page === 'order-detail')) ? COLORS.accent : 'rgba(255,255,255,0.65)', fontSize: 14, fontFamily: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
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
