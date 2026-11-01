import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/instrument-serif/400.css';
import '../../site/client/site.css';
import './member.css';
import { MemberApp } from './MemberApp';

// The member app at /app: its own small page, sharing no code with the private studio (studio.html).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MemberApp />
  </StrictMode>,
);
