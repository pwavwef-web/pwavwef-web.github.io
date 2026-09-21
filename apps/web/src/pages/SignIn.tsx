import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  getMultiFactorResolver,
  GoogleAuthProvider,
  PhoneAuthProvider,
  PhoneMultiFactorGenerator,
  RecaptchaVerifier,
  signInWithEmailAndPassword,
  signInWithPopup,
  TotpMultiFactorGenerator,
  type MultiFactorError,
  type MultiFactorResolver,
} from 'firebase/auth';
import { LockKeyhole, LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import { auth, configProblem } from '../lib/firebase';
import { useSession } from '../lib/session';
import { Logo } from '../components/shell';
import { Button, ErrorState, Field, Input, Spinner } from '../components/ui';

function friendlyAuthError(e: unknown): string {
  const code = (e as { code?: string }).code ?? '';
  const map: Record<string, string> = {
    'auth/popup-closed-by-user': 'The sign-in window was closed before finishing.',
    'auth/cancelled-popup-request': 'Another sign-in window is already open.',
    'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.',
    'auth/invalid-credential': 'That email and password do not match.',
    'auth/wrong-password': 'That email and password do not match.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/invalid-verification-code': 'That code is not correct.',
    'auth/code-expired': 'That code expired. Request a new one.',
    'auth/network-request-failed': 'Network error — check your connection.',
    'auth/unauthorized-domain': 'This domain is not authorised for sign-in.',
  };
  return map[code] ?? (e instanceof Error ? e.message : 'Sign-in failed.');
}

function Backdrop({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute -top-1/3 left-1/2 h-[900px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(76,141,255,0.22),transparent_60%)]" />
        <div className="absolute inset-x-0 top-[12%] h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
        <div className="absolute inset-x-0 bottom-[12%] h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      </div>
      <div className="relative w-full max-w-md animate-rise">{children}</div>
    </div>
  );
}

function MfaStep({ resolver, onDone }: { resolver: MultiFactorResolver; onDone: () => void }) {
  const hint = resolver.hints[0]!;
  const isPhone = hint.factorId === PhoneMultiFactorGenerator.FACTOR_ID;
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recaptchaRef = useRef<RecaptchaVerifier | null>(null);

  useEffect(() => () => recaptchaRef.current?.clear(), []);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      recaptchaRef.current ??= new RecaptchaVerifier(auth, 'mfa-recaptcha', { size: 'invisible' });
      const id = await new PhoneAuthProvider(auth).verifyPhoneNumber({ multiFactorHint: hint, session: resolver.session }, recaptchaRef.current);
      setVerificationId(id);
    } catch (e) {
      setError(friendlyAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const assertion = isPhone ? PhoneMultiFactorGenerator.assertion(PhoneAuthProvider.credential(verificationId!, code.trim())) : TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.trim());
      await resolver.resolveSignIn(assertion);
      onDone();
    } catch (e) {
      setError(friendlyAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-xl border border-line bg-black/20 p-3">
        <Smartphone className="size-5 text-accent-2" aria-hidden />
        <div className="text-sm">
          <p className="text-fg">Second step: {hint.displayName ?? (isPhone ? 'your phone' : 'your authenticator app')}</p>
          <p className="text-xs text-faint">{isPhone ? `We’ll text a code to ${(hint as { phoneNumber?: string }).phoneNumber ?? 'your phone'}.` : 'Enter the 6-digit code from your authenticator.'}</p>
        </div>
      </div>
      {isPhone && !verificationId ? (
        <Button variant="primary" className="w-full" loading={busy} onClick={() => void sendCode()}>
          Send code
        </Button>
      ) : (
        <form onSubmit={(e) => void verify(e)} className="space-y-3">
          <Field label="Verification code" htmlFor="mfa-code">
            <Input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" autoFocus />
          </Field>
          <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={code.trim().length < 6}>
            Verify and enter studio
          </Button>
        </form>
      )}
      {error && <p className="text-sm text-[#ff9b9b]">{error}</p>}
      <div id="mfa-recaptcha" />
    </div>
  );
}

export function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'google' | 'email' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolver, setResolver] = useState<MultiFactorResolver | null>(null);

  const handle = async (fn: () => Promise<unknown>, kind: 'google' | 'email') => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if ((e as { code?: string }).code === 'auth/multi-factor-auth-required') setResolver(getMultiFactorResolver(auth, e as MultiFactorError));
      else setError(friendlyAuthError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Backdrop>
      <div className="glass rounded-3xl p-7 shadow-[var(--shadow-float)] sm:p-9">
        <Logo />
        <h1 className="display mt-8 text-[44px] leading-[1.02] text-fg">
          Where the <em className="text-accent-2">films</em> get made.
        </h1>
        <p className="mt-3 text-sm text-dim">Private studio. Sign in with the owner account to continue.</p>
        {configProblem && <ErrorState className="mt-5" title="Configuration missing" error={configProblem} />}
        <div className="mt-7">
          {resolver ? (
            <MfaStep resolver={resolver} onDone={() => setResolver(null)} />
          ) : (
            <div className="space-y-4">
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                loading={busy === 'google'}
                onClick={() => void handle(() => signInWithPopup(auth, new GoogleAuthProvider().setCustomParameters({ prompt: 'select_account' })), 'google')}
              >
                Continue with Google
              </Button>
              <div className="flex items-center gap-3 text-[11px] tracking-[0.18em] text-faint uppercase">
                <span className="h-px flex-1 bg-line" />
                or
                <span className="h-px flex-1 bg-line" />
              </div>
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handle(() => signInWithEmailAndPassword(auth, email.trim(), password), 'email');
                }}
              >
                <Field label="Email" htmlFor="email">
                  <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </Field>
                <Field label="Password" htmlFor="password">
                  <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </Field>
                <Button type="submit" className="w-full" loading={busy === 'email'} disabled={!email || !password}>
                  Sign in with email
                </Button>
              </form>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-4 text-sm text-[#ff9b9b]">
              {error}
            </p>
          )}
        </div>
        <p className="mt-8 flex items-center gap-2 text-[11px] text-faint">
          <LockKeyhole className="size-3.5" aria-hidden /> Protected by Firebase Authentication, App Check and owner-only access rules.
        </p>
      </div>
    </Backdrop>
  );
}

function Denied() {
  const { user, error, signOut } = useSession();
  return (
    <Backdrop>
      <div className="glass rounded-3xl p-8 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-danger/15 text-danger">
          <ShieldCheck className="size-6" aria-hidden />
        </div>
        <h1 className="display mt-5 text-3xl">Private studio</h1>
        <p className="mt-2 text-sm text-dim">{error ?? 'This account does not have access.'}</p>
        <p className="mt-1 text-xs text-faint">Signed in as {user?.email}</p>
        <Button className="mt-6" onClick={() => void signOut()} icon={<LogOut className="size-4" />}>
          Sign out
        </Button>
      </div>
    </Backdrop>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { status, error, refresh, signOut } = useSession();
  if (status === 'loading' || status === 'checking') {
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="flex flex-col items-center gap-4">
          <Logo />
          <Spinner />
          <p className="text-xs text-faint">{status === 'checking' ? 'Verifying studio access…' : 'Loading…'}</p>
        </div>
      </div>
    );
  }
  if (status === 'signed-out') return <SignIn />;
  if (status === 'denied') return <Denied />;
  if (status === 'error') {
    return (
      <Backdrop>
        <ErrorState title="AZ Studio could not start" error={error} onRetry={() => void refresh()} />
        <Button variant="ghost" className="mt-3 w-full" onClick={() => void signOut()}>
          Sign out
        </Button>
      </Backdrop>
    );
  }
  return <>{children}</>;
}
