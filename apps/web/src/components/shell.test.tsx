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
          { path: 'studio', element: <p>Home page</p> },
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

describe('Primary navigation', () => {
  it('lists only the top-level sections; the studios live on the Create page', () => {
    expect(NAV.map((n) => n.label)).toEqual(['Home', 'Projects', 'Create', 'Assets', 'Jobs', 'Settings']);
    renderAt('/studio');
    const navs = screen.getAllByRole('navigation', { name: 'Primary' });
    expect(navs).toHaveLength(2);
    for (const nav of navs) {
      expect(within(nav).getAllByRole('link')).toHaveLength(6);
      for (const gone of ['Film Lite', 'MV Lite', 'Short Ads', 'Narrator']) expect(within(nav).queryByRole('link', { name: gone })).toBeNull();
    }
  });

  it('sends Home to the studio dashboard at /studio (the public website owns /)', () => {
    renderAt('/studio');
    for (const nav of screen.getAllByRole('navigation', { name: 'Primary' })) expect(within(nav).getByRole('link', { name: 'Home' }).getAttribute('href')).toBe('/studio');
    for (const logo of screen.getAllByRole('link', { name: 'AZ Studio home' })) expect(logo.getAttribute('href')).toBe('/studio');
  });

  it('opens the Create page', () => {
    const router = renderAt('/studio');
    fireEvent.click(within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!).getByRole('link', { name: 'Create' }));
    expect(router.state.location.pathname).toBe('/create');
    expect(screen.getByText('Create page')).toBeTruthy();
  });

  it.each([
    ['/lite', 'Film Studio Lite workspace'],
    ['/lite/p1/edit', 'Film editor'],
    ['/mvlite/p1/edit', 'Music video editor'],
    ['/ads/p1/storyboard', 'Advert editor'],
    ['/narrator/e/abc', 'Pwavwe Narrator'],
  ])('keeps Create highlighted inside %s', (path, text) => {
    renderAt(path);
    expect(screen.getByText(text)).toBeTruthy();
    const [desktop, mobile] = screen.getAllByRole('navigation', { name: 'Primary' });
    expect(within(desktop!).getByRole('link', { name: 'Create' }).className).toContain('from-accent/18');
    expect(within(desktop!).getByRole('link', { name: 'Home' }).className).not.toContain('from-accent/18');
    expect(within(mobile!).getByRole('link', { name: 'Create' }).className).toContain('text-accent-2');
    expect(within(mobile!).getByRole('link', { name: 'Home' }).className).not.toContain('text-accent-2');
  });

  it('does not highlight Create on unrelated pages', () => {
    renderAt('/assets');
    const nav = screen.getAllByRole('navigation', { name: 'Primary' })[0]!;
    expect(within(nav).getByRole('link', { name: 'Create' }).className).not.toContain('from-accent/18');
  });
});
