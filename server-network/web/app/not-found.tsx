import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="login-wrap">
      <div className="login-card">
        <h1 className="login-title">Page not found</h1>
        <p className="muted">The page you requested does not exist in the admin console.</p>
        <Link href="/">Back to the dashboard</Link>
      </div>
    </main>
  );
}
