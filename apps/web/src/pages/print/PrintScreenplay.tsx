import { useMemo } from 'react';
import { useParams } from 'react-router';
import { Printer } from 'lucide-react';
import { parseFountain, type ScriptDoc } from '@az-studio/shared';
import { useDoc } from '../../lib/data';
import { Button, Spinner } from '../../components/ui';

const page: React.CSSProperties = { fontFamily: '"Courier Prime", "Courier New", Courier, monospace', fontSize: '12pt', lineHeight: '1.0', color: '#000' };

export default function PrintScreenplay() {
  const { projectId, scriptId } = useParams();
  const script = useDoc<ScriptDoc>(projectId && scriptId ? `projects/${projectId}/scripts/${scriptId}` : null);
  const doc = useMemo(() => parseFountain(script.data?.content ?? ''), [script.data?.content]);
  if (script.loading) {
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  }
  if (!script.data) return <p className="p-8">Screenplay not found.</p>;
  const tp = doc.titlePage;
  return (
    <div className="min-h-dvh bg-white">
      <style>{`@page { size: letter; margin: 1in 1in 1in 1.5in; } @media print { .sp-page-break { break-before: page; } }`}</style>
      <div className="no-print sticky top-0 z-10 flex items-center justify-between border-b bg-white/95 px-6 py-3 text-black backdrop-blur">
        <p className="text-sm">
          {script.data.title} · {doc.pageCount} pages
        </p>
        <Button variant="primary" onClick={() => window.print()} icon={<Printer className="size-4" />}>
          Print / Save as PDF
        </Button>
      </div>
      <article className="mx-auto max-w-[6.5in] px-4 py-10 print:p-0" style={page}>
        {(tp.title || tp.author) && (
          <section className="sp-page-break flex min-h-[9in] flex-col items-center justify-center text-center" style={{ breakAfter: 'page' }}>
            <p className="text-[18pt] font-bold uppercase underline">{tp.title ?? script.data.title}</p>
            {tp.credit && <p className="mt-8">{tp.credit}</p>}
            {tp.author && <p className="mt-2">{tp.author}</p>}
            {tp['draft date'] && <p className="mt-16 self-end text-left">{tp['draft date']}</p>}
            {tp.contact && <p className="mt-4 self-start text-left whitespace-pre-line">{tp.contact}</p>}
          </section>
        )}
        {doc.elements.map((el, i) => {
          switch (el.type) {
            case 'scene_heading':
              return (
                <p key={i} className="mt-[24pt] font-bold uppercase" style={{ breakAfter: 'avoid' }}>
                  {el.sceneNumber ? `${el.sceneNumber}  ` : ''}
                  {el.text}
                </p>
              );
            case 'action':
              return (
                <p key={i} className="mt-[12pt] whitespace-pre-wrap">
                  {el.text}
                </p>
              );
            case 'character':
              return (
                <p key={i} className="mt-[12pt] uppercase" style={{ marginLeft: '2.2in', breakAfter: 'avoid' }}>
                  {el.text}
                </p>
              );
            case 'parenthetical':
              return (
                <p key={i} style={{ marginLeft: '1.6in', marginRight: '1.9in' }}>
                  {el.text}
                </p>
              );
            case 'dialogue':
              return (
                <p key={i} style={{ marginLeft: '1in', marginRight: '1.5in' }}>
                  {el.text}
                </p>
              );
            case 'transition':
              return (
                <p key={i} className="mt-[12pt] text-right uppercase">
                  {el.text}
                </p>
              );
            case 'centered':
              return (
                <p key={i} className="mt-[12pt] text-center">
                  {el.text}
                </p>
              );
            case 'lyric':
              return (
                <p key={i} className="italic" style={{ marginLeft: '1in' }}>
                  {el.text}
                </p>
              );
            case 'page_break':
              return <div key={i} className="sp-page-break" />;
            default:
              return null;
          }
        })}
      </article>
    </div>
  );
}
