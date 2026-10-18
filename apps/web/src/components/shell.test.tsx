import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Tooltip } from 'radix-ui';

vi.mock('firebase/firestore', () => ({ collection: vi.fn(), query: vi.fn(), where: vi.fn() }));
vi.mock('../lib/firebase', () => ({ db: {} }));
vi.mock('../lib/data', () => ({ useQuery: () => ({ data: [], loading: false, error: null }) }));
vi.mock('../lib/session', () => {
  const state = { user: { uid: 'owner', email: 'owner@example.com' }, boot: null, signOut: vi.fn() };
  return { useSession: (select?: (s: typeof state) => unknown) => (select ? select(state) : state) };
});

const { AppShell, NAV } = await import('./shell');

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AppShell />,
        children: [
          { index: true, element: <p>Home page</p> },
          { path: 'create', element: <p>Create page</p> },
          { path: 'ads', element: <p>Short Ads workspace</p> },
          { path: 'lite', element: <p>Film Studio Lite workspace</p> },
          { path: 'lite/:projectId/:stage?', element: <p>Film editor</p> },
          { path: 'mvlite', element: <p>Music Video Lite workspace</p> },
          { path: 'mvlite/:projectId/:stage?', element: <p>Music video editor</p> },
          { path: 'ads/:projectId/:step?', element: <p>Advert editor</p> },
          { path: 'narrator/*', element: <p>Pwavwe Narrator</p> },
          { path: '*', element: <p>Other page</p> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  render(
    <Tooltip.Provider>
      <RouterProvider router={router} />
    </Tooltip.Provider>,
  );
  return router;
}

afterEach(cleanup);

describe('Short Ads tab', () => {
  it('follows MV Lite in the primary navigation, between Create and Assets', () => {
    expect(NAV).toHaveLength(10);
    expect(NAV.map((n) => n.label)).toEqual(['Home', 'Projects', 'Create', 'Film Lite', 'MV Lite', 'Short Ads', 'Narrator', 'Assets', 'Jobs', 'Settings']);
    expect(NAV.find((n) => n.label === 'Short Ads')?.to).toBe('/ads');
  });

  it('appears in both the desktop sidebar and the mobile bar and opens the workspace', () => {
    const router = renderAt('/');
    const navs = screen.getAllByRole('navigation', { name: 'Primary' });
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      const links = within(nav).getAllByRole('link');
      expect(links).toHaveLength(10);
      expect(links[5]!.textContent).toBe('Short Ads');
      expect(links[5]!.getAttribute('href')).toBe('/ads');
    }
    fireEvent.click(within(navs[0]!).getByRole('link', { name: 'Short Ads' }));
    expect(router.state.location.pathname).toBe('/ads');
    expect(screen.getByText('Short Ads workspace')).toBeTruthy();
    for (const nav of screen.getAllByRole('navigation', { name: 'Primary' })) {
      expect(within(nav).getByRole('link', { name: 'Short Ads' }).getAttribute('aria-current')).toBe('page');
    }
  });

  it('stays highlighted inside an advert', () => {
    renderAt('/ads/p1/storyboard');
    expect(screen.getByText('Advert editor')).toBeTruthy();
    const nav = screen.getAllByRole('navigation', { name: 'Primary' })[0]!;
    expect(within(nav).getByRole('link', { name: 'Short Ads' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Create' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('Pwavwe Narrator tab', () => {
  it('is in both navigations, opens /narrator and stays highlighted inside an edition', () => {
    const router = renderAt('/');
    for (const nav of screen.getAllByRole('navigation', { name: 'Primary' })) expect(within(nav).getByRole('link', { name: 'Narrator' }).getAttribute('href')).toBe('/narrator');
    fireEvent.click(within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!).getByRole('link', { name: 'Narrator' }));
    expect(router.state.location.pathname).toBe('/narrator');
    cleanup();
    renderAt('/narrator/e/abc');
    expect(within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!).getByRole('link', { name: 'Narrator' }).getAttribute('aria-current')).toBe('page');
  });
});

describe('Film Studio Lite tab', () => {
  it('sits after Create in both navigations and stays highlighted inside a film', () => {
    const router = renderAt('/');
    for (const nav of screen.getAllByRole('navigation', { name: 'Primary' })) {
      const link = within(nav).getByRole('link', { name: 'Film Lite' });
      expect(link.getAttribute('href')).toBe('/lite');
    }
    fireEvent.click(within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!).getByRole('link', { name: 'Film Lite' }));
    expect(router.state.location.pathname).toBe('/lite');
    expect(screen.getByText('Film Studio Lite workspace')).toBeTruthy();
    cleanup();
    renderAt('/lite/p1/edit');
    const nav = screen.getAllByRole('navigation', { name: 'Primary' })[0]!;
    expect(within(nav).getByRole('link', { name: 'Film Lite' }).getAttribute('aria-current')).toBe('page');
  });
});

describe('Music Video Lite tab', () => {
  it('follows Film Lite in both navigations and stays highlighted inside a video', () => {
    const router = renderAt('/');
    for (const nav of screen.getAllByRole('navigation', { name: 'Primary' })) expect(within(nav).getByRole('link', { name: 'MV Lite' }).getAttribute('href')).toBe('/mvlite');
    fireEvent.click(within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!).getByRole('link', { name: 'MV Lite' }));
    expect(router.state.location.pathname).toBe('/mvlite');
    expect(screen.getByText('Music Video Lite workspace')).toBeTruthy();
    cleanup();
    renderAt('/mvlite/p1/edit');
    const nav = screen.getAllByRole('navigation', { name: 'Primary' })[0]!;
    expect(within(nav).getByRole('link', { name: 'MV Lite' }).getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Film Lite' }).getAttribute('aria-current')).toBeNull();
  });
});
