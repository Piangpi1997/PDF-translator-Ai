import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Activity, AudioLines, Bell, BookOpen, BookOpenCheck, Bookmark, ChartNoAxesColumn, Check, ChevronDown, CircleHelp, Eye, EyeOff, FileUp, Heart, Home, Library, LogOut, Menu, Search, Server, Settings, ShieldCheck, Sparkles, X } from 'lucide-react';
import { api, apiOrigin, checkApiHealth, setApiOrigin } from './api.js';
import { Dashboard, LibraryPage, BookDetails, ReaderPage, ReviewPage, AudioPage, StatisticsPage, GlossaryPage, SettingsPage, EmptyState } from './pages.jsx';

const menu = [
  { to: '/', label: 'Dashboard', icon: Home },
  { to: '/library', label: 'My Library', icon: Library },
  { to: '/audio', label: 'Audio library', icon: AudioLines },
  { to: '/statistics', label: 'Statistics', icon: ChartNoAxesColumn },
  { to: '/glossary', label: 'Glossary', icon: BookOpenCheck },
  { to: '/settings', label: 'Settings', icon: Settings }
];

export function AuthScreen({ onLogin, error: initialError }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [error, setError] = useState(initialError || '');
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState(apiOrigin());
  const [checking, setChecking] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState(null);
  const [serverError, setServerError] = useState('');
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api(`/auth/${mode === 'signup' ? 'signup' : 'login'}`, { method: 'POST', body: mode === 'signup' ? { name, email, password } : { email, password } });
      onLogin(result.user);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const checkConnection = async () => {
    setChecking(true); setConnectionNotice(null); setServerError('');
    try {
      await checkApiHealth(origin);
      setConnectionNotice({ ok: true, text: 'The app API responded successfully.' });
    } catch (e) {
      const detail = ['Failed to fetch', 'Load failed'].includes(e.message) ? 'Check the address and network, then try again.' : e.message;
      setConnectionNotice({ ok: false, text: `Could not confirm this server. ${detail}` });
    } finally { setChecking(false); }
  };
  const saveServer = () => {
    try {
      const savedOrigin = setApiOrigin(origin);
      setOrigin(savedOrigin);
      setServerError('');
      setConnectionNotice({ ok: true, text: 'Saved on this device. Reconnecting…' });
      setReconnecting(true);
      window.setTimeout(() => window.location.reload(), 350);
    } catch (e) { setServerError(e.message); setConnectionNotice(null); }
  };
  return <main className="auth-screen"><section className="card auth-card">
    <aside className="auth-intro">
      <Brand />
      <div className="auth-intro-copy">
        <div className="auth-kicker"><ShieldCheck size={14}/>A private reading workspace</div>
        <h1>Read with more<br/>understanding.</h1>
        <p>Bring your books, translation review, and Myanmar reading together in one thoughtful space.</p>
        <div className="auth-feature-list">
          <div className="auth-feature"><BookOpen size={17}/><span><strong>Import your books</strong><small>PDF, EPUB, DOCX, and TXT</small></span></div>
          <div className="auth-feature"><Sparkles size={17}/><span><strong>Review page by page</strong><small>Keep your reading in your hands</small></span></div>
          <div className="auth-feature"><Settings size={17}/><span><strong>Make it yours</strong><small>Choose your font and reading theme</small></span></div>
        </div>
      </div>
      <div className="auth-intro-footer"><ShieldCheck size={17}/><span><strong>Your library stays yours.</strong><small>Books and notes are private to your account.</small></span></div>
    </aside>
    <div className="auth-content">
      <header className="auth-form-heading"><div className="eyebrow">{mode === 'login' ? 'Welcome back' : 'A quiet place for your books'}</div><h2>{mode === 'login' ? 'Sign in to your library' : 'Create your account'}</h2><p>{mode === 'login' ? 'Pick up where you left off.' : 'Set up a private library for your reading.'}</p></header>
      <div className="auth-tabs" role="tablist" aria-label="Account access"><button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(''); }}>Sign in</button><button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setError(''); }}>Create account</button></div>
      {error && <div className="notice error" role="alert">{error}</div>}
      <form className="form-grid auth-form" onSubmit={submit}>
        {mode === 'signup' && <label className="field"><span className="form-label">Name</span><input className="input" autoComplete="name" value={name} onChange={e => setName(e.target.value)} required minLength={2}/></label>}
        <label className="field"><span className="form-label">Email</span><input className="input" type="email" autoComplete="email" inputMode="email" value={email} onChange={e => setEmail(e.target.value)} required/></label>
        <label className="field"><span className="form-label">Password</span><span className="auth-password-field"><input id="auth-password" className="input" type={passwordVisible ? 'text' : 'password'} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={mode === 'signup' ? 10 : 1}/><button type="button" className="auth-password-toggle" aria-label={passwordVisible ? 'Hide password' : 'Show password'} aria-pressed={passwordVisible} onClick={() => setPasswordVisible(value => !value)}>{passwordVisible ? <EyeOff size={17}/> : <Eye size={17}/>}</button></span>{mode === 'signup' && <span className="caption">Use at least 10 characters.</span>}</label>
        <button type="submit" className="button auth-submit" disabled={busy}>{busy ? <><span className="spinner"/>Please wait…</> : mode === 'signup' ? 'Create your account' : 'Sign in'}</button>
      </form>
      <details className="auth-server">
        <summary><span className="auth-server-mark"><Server size={16}/></span><span className="auth-server-title"><strong>Server connection</strong><small>{origin.trim() ? 'A custom server is selected' : 'Using this app’s server'}</small></span><ChevronDown size={16}/></summary>
        <div className="auth-server-content">
          <p>On the web, leave this empty to use the current site. The Android app needs a reachable HTTPS server. Enter an origin only—never a path, username, or password.</p>
          <label className="field"><span className="form-label">Backend origin</span><input className="input" type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck="false" value={origin} onChange={e => { setOrigin(e.target.value); setConnectionNotice(null); setServerError(''); }} placeholder="https://" aria-describedby="auth-server-help"/><span className="caption" id="auth-server-help">Leave blank to use this site’s API. Server addresses are stored on this device.</span></label>
          <div className="auth-server-actions"><button type="button" className="button secondary small" onClick={checkConnection} disabled={checking}>{checking ? <><span className="spinner"/>Checking…</> : 'Check connection'}</button><button type="button" className="button small" onClick={saveServer} disabled={reconnecting}>{reconnecting ? 'Reconnecting…' : 'Save & reconnect'}</button></div>
          {connectionNotice && <div className={`notice ${connectionNotice.ok ? 'info' : 'error'}`} role="status">{connectionNotice.text}</div>}
          {serverError && <div className="notice error" role="alert">{serverError}</div>}
          <p className="caption auth-server-trust">Sign-in details are sent to the selected server. Use only a server you trust.</p>
        </div>
      </details>
      <div className="auth-security"><ShieldCheck size={15}/><span>Your books, notes, and reading activity are private to your account.</span></div>
    </div>
  </section></main>;
}

export function Brand() { return <div className="brand"><div className="brand-mark"><BookOpen size={19}/></div><div><div className="brand-name">Myanmar Reader</div><div className="brand-caption">Read deeply. Understand more.</div></div></div>; }

function NotificationMenu({ toast }) {
  const [open, setOpen] = useState(false); const [items, setItems] = useState([]); const [unread, setUnread] = useState(0); const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => { try { const r = await api('/notifications'); setItems(r.notifications || []); setUnread(r.unread_count || 0); } catch {} }, []);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 30000); return () => clearInterval(timer); }, [refresh]);
  const markRead = async item => { try { await api(`/notifications/${item.id}/read`, { method: 'POST' }); refresh(); } catch (e) { toast(e.message); } };
  const dismiss = async item => { try { await api(`/notifications/${item.id}`, { method: 'DELETE' }); refresh(); } catch (e) { toast(e.message); } };
  const markAll = async () => { setLoading(true); try { await api('/notifications/read-all', { method: 'POST' }); await refresh(); } catch (e) { toast(e.message); } finally { setLoading(false); } };
  return <div style={{position:'relative'}}><button className="icon-button" aria-label="Notifications" onClick={() => { setOpen(v => !v); if (!open) refresh(); }}><Bell size={17}/>{unread > 0 && <span style={{position:'absolute',right:-2,top:-4,minWidth:17,height:17,background:'#ad5548',color:'white',borderRadius:20,fontSize:9,display:'grid',placeItems:'center',padding:'0 4px'}}>{unread > 9 ? '9+' : unread}</span>}</button>{open && <div className="notification-popover"><div className="section-title"><div><h2>Notifications</h2><p>{unread} unread</p></div><button className="button ghost small" disabled={!unread || loading} onClick={markAll}>Mark all read</button></div>{items.length ? items.map(item => <div key={item.id} className={`notification-item ${!item.read_at ? 'unread' : ''}`}><div style={{display:'flex',justifyContent:'space-between',gap:8}}><strong>{item.kind.replaceAll('_',' ')}</strong><button className="icon-button" style={{width:26,height:26}} aria-label="Dismiss notification" onClick={() => dismiss(item)}><X size={13}/></button></div><span>{item.message}</span><div className="caption">{new Date(item.created_at).toLocaleString()}</div>{!item.read_at && <button className="link" style={{border:0,background:'transparent',padding:0,textAlign:'left',fontSize:11}} onClick={() => markRead(item)}>Mark as read</button>}</div>) : <EmptyState title="You're all caught up" description="Import, translation, and audio updates will appear here." icon={Bell}/>}</div>}</div>;
}

function Sidebar({ open, close, onImport }) {
  return <><div className={`sidebar ${open ? 'open' : ''}`}><Brand/><div className="nav-group"><div className="nav-label">Workspace</div>{menu.map(item => { const Icon = item.icon; return <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({isActive}) => `nav-link ${isActive ? 'active' : ''}`} onClick={close}><Icon size={17}/>{item.label}</NavLink>; })}</div><div className="sidebar-bottom"><div className="card" style={{padding:14,background:'var(--paper)'}}><div style={{display:'flex',gap:8,alignItems:'center',marginBottom:6}}><ShieldCheck size={16} color="var(--green)"/><strong style={{fontSize:12}}>Private by design</strong></div><p className="caption" style={{margin:0}}>Your reading data stays with your account.</p></div><button className="button secondary" onClick={() => { onImport(); close(); }}><FileUp size={16}/>Import a book</button><a className="nav-link" href="https://cue.im/feedback" target="_blank" rel="noreferrer"><CircleHelp size={16}/>Help & feedback</a></div></div>{open && <button aria-label="Close navigation" onClick={close} style={{position:'fixed',inset:0,zIndex:35,border:0,background:'#1a201a66'}}/>}</>;
}

function AppShell({ user, onLogout, ctx }) {
  const [mobileOpen, setMobileOpen] = useState(false); const [importOpen, setImportOpen] = useState(false); const location = useLocation();
  const path = location.pathname;
  const title = path.startsWith('/book/') ? 'Book details' : path.startsWith('/reader/') ? 'Reading room' : path.startsWith('/review/') ? 'Translation review' : (menu.find(item => item.to === path)?.label || 'Myanmar Reader');
  return <div className="app-shell"><Sidebar open={mobileOpen} close={() => setMobileOpen(false)} onImport={() => setImportOpen(true)}/><div className="main-column"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu" aria-label="Open menu" onClick={() => setMobileOpen(true)}><Menu size={18}/></button><span className="topbar-title">{title}</span></div><div className="topbar-actions"><span className="topbar-user">Hello, {user.name.split(' ')[0]}</span><NotificationMenu toast={ctx.toast}/><button className="icon-button" aria-label="Sign out" title="Sign out" onClick={onLogout}><LogOut size={16}/></button></div></header><main className="content"><Routes>
    <Route path="/" element={<Dashboard ctx={ctx} onImport={() => setImportOpen(true)}/>}/>
    <Route path="/library" element={<LibraryPage ctx={ctx} onImport={() => setImportOpen(true)}/>}/>
    <Route path="/book/:bookId" element={<BookDetails ctx={ctx}/>}/>
    <Route path="/reader/:bookId" element={<ReaderPage ctx={ctx}/>}/>
    <Route path="/review/:bookId" element={<ReviewPage ctx={ctx}/>}/>
    <Route path="/audio" element={<AudioPage ctx={ctx}/>}/>
    <Route path="/statistics" element={<StatisticsPage ctx={ctx}/>}/>
    <Route path="/glossary" element={<GlossaryPage ctx={ctx}/>}/>
    <Route path="/settings" element={<SettingsPage ctx={ctx}/>}/>
    <Route path="*" element={<EmptyState title="Page not found" description="This page is not available." icon={Search}/>}/>
  </Routes></main></div>{importOpen && <ImportDialog onClose={() => setImportOpen(false)} onDone={book => { setImportOpen(false); ctx.refreshBooks(); ctx.navigate(`/book/${book.id}`); }}/>}</div>;
}

function ImportDialog({ onClose, onDone }) {
  const [mode, setMode] = useState('file'); const [provider, setProvider] = useState('free_ai'); const [file, setFile] = useState(null); const [url, setUrl] = useState(''); const [title, setTitle] = useState(''); const [author, setAuthor] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      let result;
      if (mode === 'file') {
        if (!file) throw new Error('Choose a document first.');
        const form = new FormData(); form.append('file', file); form.append('provider', provider); if (title) form.append('title', title); if (author) form.append('author', author);
        result = await api('/books/import', { method: 'POST', body: form });
      } else result = await api('/books/import-online-pdf', { method: 'POST', body: { url, provider, title, author } });
      onDone(result.book);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="import-heading"><div className="modal-header"><div><div className="eyebrow">Add to your library</div><h2 id="import-heading">Bring a book in</h2></div><button className="icon-button" aria-label="Close" onClick={onClose}><X size={17}/></button></div><div className="auth-tabs"><button className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>Upload a file</button><button className={mode === 'online' ? 'active' : ''} onClick={() => setMode('online')}>Read Online PDF</button></div><form className="form-grid" onSubmit={submit}>
    {mode === 'file' ? <label className="dropzone"><FileUp size={22} color="var(--green)"/><div style={{fontWeight:600,marginTop:9}}>{file ? file.name : 'Choose a document to upload'}</div><div className="caption" style={{margin:'5px 0 12px'}}>PDF, DOCX, EPUB, or TXT · up to 25 MB</div><input type="file" accept=".pdf,.docx,.epub,.txt,application/pdf" onChange={e => setFile(e.target.files?.[0] || null)} required/></label> : <label className="field"><span className="form-label">Public PDF URL</span><input className="input" type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.org/book.pdf" required/><span className="caption">The server validates the host and every redirect, verifies the PDF, and stores a private copy.</span></label>}
    <div className="two-col"><label className="field"><span className="form-label">Title <span className="muted">(optional)</span></span><input className="input" value={title} onChange={e => setTitle(e.target.value)} maxLength={250} placeholder="Detected from the document"/></label><label className="field"><span className="form-label">Author <span className="muted">(optional)</span></span><input className="input" value={author} onChange={e => setAuthor(e.target.value)} maxLength={250} placeholder="Detected when available"/></label></div>
    <label className="field"><span className="form-label">Translation provider</span><select className="select" value={provider} onChange={e => setProvider(e.target.value)}><option value="free_ai">Free AI Translation — No API key required</option><option value="kimi_k3">Kimi K3</option></select><span className="caption">You can change the provider when starting translation. Missing services will return a retryable error, never a fake translation.</span></label>
    {error && <div className="notice error" role="alert">{error}</div>}<div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button" disabled={busy}>{busy ? <span className="spinner"/> : mode === 'online' ? 'Import public PDF' : 'Import book'}</button></div>
  </form></section></div>;
}

export default function App() {
  const [user, setUser] = useState(null); const [initializing, setInitializing] = useState(true); const [authError, setAuthError] = useState(''); const [books, setBooks] = useState([]); const [providers, setProviders] = useState(null); const [toastMessage, setToastMessage] = useState(''); const navigate = useNavigate();
  const toast = useCallback(message => { setToastMessage(message); window.setTimeout(() => setToastMessage(''), 3600); }, []);
  const refreshBooks = useCallback(async () => { try { const result = await api('/books'); setBooks(result.books || []); } catch (e) { if (e.message !== 'Sign in to continue.') toast(e.message); } }, [toast]);
  const refreshProviders = useCallback(async () => { try { setProviders(await api('/config/providers')); } catch {} }, []);
  useEffect(() => { api('/auth/me').then(result => setUser(result.user || null)).catch(e => setAuthError(e.message)).finally(() => setInitializing(false)); }, []);
  useEffect(() => { if (user) { refreshBooks(); refreshProviders(); } else { setBooks([]); setProviders(null); } }, [user, refreshBooks, refreshProviders]);
  const handleLogout = async () => { try { await api('/auth/logout', { method: 'POST' }); } catch {} setUser(null); navigate('/'); };
  const ctx = useMemo(() => ({ user, books, setBooks, providers, refreshBooks, refreshProviders, toast, navigate }), [user, books, providers, refreshBooks, refreshProviders, toast, navigate]);
  if (initializing) return <div className="loading" style={{height:'100vh'}}><span className="spinner"/></div>;
  return <>{user ? <AppShell user={user} onLogout={handleLogout} ctx={ctx}/> : <AuthScreen onLogin={setUser} error={authError}/ >}{toastMessage && <div className="toast" role="status">{toastMessage}</div>}</>;
}
