import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useRouteError } from 'react-router';
import { Tooltip } from 'radix-ui';
import { Toaster } from 'sonner';
import { AppShell } from './components/shell';
import { AuthGate } from './pages/SignIn';
import { ErrorState, Spinner } from './components/ui';

const Home = lazy(() => import('./pages/Home'));
const Projects = lazy(() => import('./pages/Projects'));
const ProjectRouter = lazy(() => import('./pages/ProjectRouter'));
const Create = lazy(() => import('./pages/Create'));
const QuickVideo = lazy(() => import('./pages/QuickVideo'));
const ImageStudio = lazy(() => import('./pages/ImageStudio'));
const Remix = lazy(() => import('./pages/Remix'));
const Assets = lazy(() => import('./pages/Assets'));
const Jobs = lazy(() => import('./pages/Jobs'));
const Settings = lazy(() => import('./pages/Settings'));
const FilmStudio = lazy(() => import('./pages/film/FilmStudio'));
const MusicStudio = lazy(() => import('./pages/music/MusicStudio'));
const TimelineEditor = lazy(() => import('./pages/editor/TimelineEditor'));
const PrintScreenplay = lazy(() => import('./pages/print/PrintScreenplay'));
const PrintStoryboard = lazy(() => import('./pages/print/PrintStoryboard'));

function Page({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-[50vh] place-items-center">
          <Spinner />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

function RouteError() {
  const error = useRouteError();
  return (
    <div className="mx-auto max-w-xl p-8">
      <ErrorState title="This page failed to load" error={error} onRetry={() => window.location.reload()} />
    </div>
  );
}

function NotFound() {
  return (
    <div className="grid min-h-[60vh] place-items-center text-center">
      <div>
        <p className="eyebrow">404</p>
        <p className="display mt-2 text-4xl">This reel is missing</p>
        <a href="/" className="mt-4 inline-block text-sm text-accent-2 hover:underline">
          Back to Home
        </a>
      </div>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: (
      <AuthGate>
        <Outlet />
      </AuthGate>
    ),
    errorElement: <RouteError />,
    children: [
      {
        element: <AppShell />,
        errorElement: <RouteError />,
        children: [
          { index: true, element: <Page><Home /></Page> },
          { path: 'projects', element: <Page><Projects /></Page> },
          { path: 'projects/:projectId', element: <Page><ProjectRouter /></Page> },
          { path: 'projects/:projectId/film/:tab?', element: <Page><FilmStudio /></Page> },
          { path: 'projects/:projectId/music/:tab?', element: <Page><MusicStudio /></Page> },
          { path: 'create', element: <Page><Create /></Page> },
          { path: 'create/video', element: <Page><QuickVideo /></Page> },
          { path: 'create/image', element: <Page><ImageStudio /></Page> },
          { path: 'create/remix', element: <Page><Remix /></Page> },
          { path: 'assets', element: <Page><Assets /></Page> },
          { path: 'jobs', element: <Page><Jobs /></Page> },
          { path: 'settings', element: <Page><Settings /></Page> },
          { path: 'home', element: <Navigate to="/" replace /> },
          { path: '*', element: <NotFound /> },
        ],
      },
      { path: 'projects/:projectId/timeline/:timelineId', element: <Page><TimelineEditor /></Page>, errorElement: <RouteError /> },
      { path: 'print/screenplay/:projectId/:scriptId', element: <Page><PrintScreenplay /></Page> },
      { path: 'print/storyboard/:projectId', element: <Page><PrintStoryboard /></Page> },
    ],
  },
]);

export function App() {
  return (
    <Tooltip.Provider delayDuration={300}>
      <RouterProvider router={router} />
      <Toaster theme="dark" position="bottom-right" richColors closeButton toastOptions={{ style: { background: '#0f1726', border: '1px solid rgba(150,172,214,0.2)', color: '#e9eef7' } }} />
    </Tooltip.Provider>
  );
}
