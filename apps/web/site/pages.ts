import { EARLY_ACCESS_CONSENT_TEXT, EARLY_ACCESS_INTERESTS, EARLY_ACCESS_LIMITS, EARLY_ACCESS_NOTICE_VERSION, EARLY_ACCESS_PATH } from '@az-studio/shared/early-access';
import { html, raw, type Html } from './html';
import { icon, type IconName } from './icons';
import { BLOG_URL, CONTACT_URL } from './config';
import { FAQ, HIGHLIGHTS, IDEAS, PREPARING, SHOWCASE, STATUS_LABEL, WORKFLOWS, type Feature, type ShowcaseEntry, type Status } from './content';

const STATUS_ICON: Record<Status, IconName> = { working: 'check', preparing: 'clock', idea: 'idea' };
const statusPill = (s: Status) => html`<span class="status status-${s}">${icon(STATUS_ICON[s], 'icon icon-small')}${STATUS_LABEL[s]}</span>`;

const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const pageIntro = (eyebrow: string, title: string, lede: Html | string) => html`<section class="page-intro">
  <div class="container narrow">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p class="lede">${lede}</p>
  </div>
</section>`;

const ctaBand = (title = 'Interested in trying AZ Studio?', body = 'Join the early-access list to hear when invitations start. Access will open gradually, in small groups.') => html`<section class="cta-band">
  <div class="container cta-inner reveal">
    <div>
      <h2>${title}</h2>
      <p>${body}</p>
    </div>
    <a class="button button-primary" href="/early-access">Join the early-access list ${icon('arrow')}</a>
  </div>
</section>`;

/** Decorative hero drawing: four kinds of material coming together on one timeline (not a product screenshot). */
const heroArt = raw(`<svg class="hero-art" viewBox="0 0 560 470" role="presentation" aria-hidden="true" focusable="false">
  <defs>
    <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.3" class="art-dot"/></pattern>
  </defs>
  <rect x="8" y="8" width="544" height="454" rx="30" class="art-panel"/>
  <rect x="8" y="8" width="544" height="454" rx="30" fill="url(#dots)"/>
  <g class="art-card art-card-1">
    <rect x="44" y="52" width="214" height="148" rx="16" class="art-surface"/>
    <text x="66" y="84" class="art-label">Story</text>
    <rect x="66" y="102" width="160" height="8" rx="4" class="art-line"/>
    <rect x="66" y="122" width="132" height="8" rx="4" class="art-line"/>
    <rect x="66" y="142" width="150" height="8" rx="4" class="art-line"/>
    <rect x="66" y="162" width="96" height="8" rx="4" class="art-line"/>
  </g>
  <g class="art-card art-card-2">
    <rect x="290" y="40" width="226" height="164" rx="16" class="art-surface"/>
    <text x="312" y="72" class="art-label">Pictures</text>
    <rect x="312" y="88" width="182" height="96" rx="10" class="art-sky"/>
    <circle cx="462" cy="112" r="11" class="art-sun"/>
    <path d="M312 184 L362 136 L398 168 L430 144 L494 184 Z" class="art-hill"/>
  </g>
  <g class="art-card art-card-3">
    <rect x="44" y="226" width="226" height="120" rx="16" class="art-surface"/>
    <text x="66" y="258" class="art-label">Music</text>
    <g class="art-bars">
      <rect x="66" y="292" width="8" height="26" rx="4"/><rect x="82" y="282" width="8" height="46" rx="4"/><rect x="98" y="296" width="8" height="18" rx="4"/>
      <rect x="114" y="276" width="8" height="58" rx="4"/><rect x="130" y="288" width="8" height="34" rx="4"/><rect x="146" y="298" width="8" height="14" rx="4"/>
      <rect x="162" y="280" width="8" height="50" rx="4"/><rect x="178" y="290" width="8" height="30" rx="4"/><rect x="194" y="284" width="8" height="42" rx="4"/>
      <rect x="210" y="296" width="8" height="18" rx="4"/><rect x="226" y="288" width="8" height="34" rx="4"/>
    </g>
  </g>
  <g class="art-card art-card-4">
    <rect x="300" y="232" width="216" height="114" rx="16" class="art-surface"/>
    <text x="322" y="264" class="art-label">Voice</text>
    <path d="M322 304 C340 280, 356 328, 374 304 S408 280, 426 304 S460 328, 478 304" class="art-wave"/>
  </g>
  <g class="art-timeline">
    <rect x="44" y="378" width="472" height="52" rx="14" class="art-surface"/>
    <rect x="58" y="392" width="112" height="24" rx="6" class="art-clip art-clip-1"/>
    <rect x="176" y="392" width="146" height="24" rx="6" class="art-clip art-clip-2"/>
    <rect x="328" y="392" width="78" height="24" rx="6" class="art-clip art-clip-3"/>
    <rect x="412" y="392" width="90" height="24" rx="6" class="art-clip art-clip-4"/>
    <rect x="286" y="384" width="3" height="40" rx="1.5" class="art-playhead"/>
  </g>
</svg>`);

function featureCard(f: Feature): Html {
  return html`<li class="feature reveal">
    ${statusPill(f.status)}
    <h3>${f.title}</h3>
    <p>${f.body}</p>
  </li>`;
}

// ---------------------------------------------------------------------------------------------------------

export function homePage(): Html {
  const preview = FAQ.slice(0, 3);
  return html`<section class="hero">
  <div class="container hero-grid">
    <div class="hero-copy">
      <p class="eyebrow">An independent creative workspace by Francis Pwavwe</p>
      <h1>Make room for your next creative idea.</h1>
      <p class="lede">AZ Studio brings creative tools into one workspace for turning ideas into videos, images, music and narrated stories. It’s in private use today, and we’re preparing a public experience — starting with a closer look at what’s possible.</p>
      <div class="actions">
        <a class="button button-primary" href="/early-access">Join the early-access list ${icon('arrow')}</a>
        <a class="button button-secondary" href="/showcase">Explore the showcase</a>
      </div>
      <p class="stage-note">${icon('clock', 'icon icon-small')}<span><strong>Current stage:</strong> private studio · early-access list open · no public tools yet</span></p>
    </div>
    <div class="hero-visual">${heroArt}</div>
  </div>
</section>

<section class="section" aria-labelledby="make-title">
  <div class="container">
    <div class="section-head">
      <p class="eyebrow">What it helps make</p>
      <h2 id="make-title">A few things AZ Studio already does</h2>
      <p>Each of these works today in the private studio. Every paid step shows an estimate before it runs.</p>
    </div>
    <ul class="highlight-grid">
      ${HIGHLIGHTS.map((h) => html`<li class="highlight reveal">
        <span class="highlight-icon">${icon(h.icon as IconName)}</span>
        <h3>${h.title}</h3>
        <p>${h.body}</p>
      </li>`)}
    </ul>
    <p class="section-link"><a href="/explore">See every workflow and its status ${icon('arrow', 'icon icon-small')}</a></p>
  </div>
</section>

<section class="section section-tinted" aria-labelledby="stage-title">
  <div class="container">
    <div class="section-head">
      <p class="eyebrow">Launch stage</p>
      <h2 id="stage-title">Where AZ Studio is now</h2>
      <p>The public side is opening step by step. There are no dates yet — each stage starts when the one before it shows what works.</p>
    </div>
    <ol class="stages">
      <li class="stage stage-now reveal">
        <span class="stage-tag">Now</span>
        <h3>A private studio</h3>
        <p>Francis uses AZ Studio for his own films, music and narrated essays. This website and the early-access list are the first public pieces.</p>
      </li>
      <li class="stage reveal">
        <span class="stage-tag">Next</span>
        <h3>Small-group early access</h3>
        <p>Invited people try selected tools from their own accounts, with clear limits on use. Who is invited, and when, hasn’t been decided.</p>
      </li>
      <li class="stage reveal">
        <span class="stage-tag">Later</span>
        <h3>A public product</h3>
        <p>Broader access, and possibly paid plans or credits — shaped by what early access teaches. Nothing about pricing is settled.</p>
      </li>
    </ol>
  </div>
</section>

<section class="section" aria-labelledby="work-title">
  <div class="container split">
    <div>
      <p class="eyebrow">Showcase</p>
      <h2 id="work-title">Listen to work made with AZ Studio</h2>
      <p>The showcase holds pieces that have been published for the public — starting with narrated audio editions of essays from The Pwavwe Papers.</p>
      <p><a class="button button-secondary" href="/showcase">Explore the showcase</a></p>
    </div>
    <ul class="mini-list">
      ${SHOWCASE.slice(0, 3).map((s) => html`<li class="reveal"><a href="/showcase#${s.id}"><span class="mini-kind">${icon(s.kind === 'audio' ? 'voice' : s.kind === 'video' ? 'film' : 'image', 'icon icon-small')}${s.meta}</span><span class="mini-title">${s.title}</span></a></li>`)}
    </ul>
  </div>
</section>

<section class="section section-tinted" aria-labelledby="person-title">
  <div class="container split">
    <div>
      <p class="eyebrow">The person behind it</p>
      <h2 id="person-title">Built by Francis Pwavwe</h2>
    </div>
    <div class="prose">
      <p>AZ Studio is an independent project. Francis writes <a href="${BLOG_URL}">The Pwavwe Papers</a> and makes films, music and audio, and he built AZ Studio to keep that work in one place instead of scattered across many apps.</p>
      <p>It’s also a place to experiment — to try an idea quickly, see whether it works, and keep what’s worth keeping.</p>
      <p><a href="/about">More about the project ${icon('arrow', 'icon icon-small')}</a></p>
    </div>
  </div>
</section>

<section class="section" aria-labelledby="faq-title">
  <div class="container narrow">
    <div class="section-head">
      <p class="eyebrow">Questions</p>
      <h2 id="faq-title">Before you join</h2>
    </div>
    <div class="faq-list">
      ${preview.map((f) => html`<details class="faq-item reveal"><summary>${f.q}</summary><div class="faq-answer"><p>${raw(f.a)}</p></div></details>`)}
    </div>
    <p class="section-link"><a href="/faq">All questions and contact ${icon('arrow', 'icon icon-small')}</a></p>
  </div>
</section>

${ctaBand()}`;
}

export function explorePage(): Html {
  return html`${pageIntro('Explore AZ Studio', 'What AZ Studio is for', 'AZ Studio is organised around a few creative workflows. Each keeps a whole project together — the writing, pictures, sound and edit — and shows what a paid step will cost before it runs.')}

<section class="section section-tight">
  <div class="container">
    <div class="legend" role="note" aria-label="How to read the status labels">
      <p>${statusPill('working')}<span>Used today in Francis’s private studio — not yet open to anyone else.</span></p>
      <p>${statusPill('preparing')}<span>Groundwork for letting invited people in.</span></p>
      <p>${statusPill('idea')}<span>Being considered. Not promised.</span></p>
    </div>
  </div>
</section>

${WORKFLOWS.map(
  (w, i) => html`<section class="section ${i % 2 ? 'section-tinted' : ''}" id="${w.id}" aria-labelledby="${w.id}-title">
  <div class="container">
    <div class="workflow-head">
      <span class="highlight-icon">${icon(w.icon)}</span>
      <div>
        <h2 id="${w.id}-title">${w.title}</h2>
        <p>${w.intro}</p>
      </div>
    </div>
    <ul class="feature-grid">${w.features.map(featureCard)}</ul>
  </div>
</section>`,
)}

<section class="section" aria-labelledby="next-title">
  <div class="container">
    <div class="section-head">
      <p class="eyebrow">Opening up</p>
      <h2 id="next-title">Being prepared, and further out</h2>
      <p>Which tools open first hasn’t been decided. Joining the early-access list doesn’t give immediate access to any of the workflows above.</p>
    </div>
    <ul class="feature-grid">${PREPARING.map(featureCard)}${IDEAS.map(featureCard)}</ul>
  </div>
</section>

${ctaBand()}`;
}

function showcaseItem(s: ShowcaseEntry): Html {
  const media =
    s.kind === 'audio' && s.audioEditionId
      ? html`<div class="player-frame">
          <iframe src="/embed/audio/${s.audioEditionId}?theme=auto" title="Audio player: ${s.title}" loading="lazy" scrolling="no" referrerpolicy="strict-origin-when-cross-origin"></iframe>
        </div>
        <p class="media-fallback"><a href="/embed/audio/${s.audioEditionId}">Open the player on its own page</a> · audio loads only when you press play.</p>`
      : s.kind === 'video' && s.video
        ? html`<video class="showcase-video" controls preload="none" playsinline poster="${s.video.poster}" width="${s.video.width}" height="${s.video.height}">
            <source src="${s.video.src}" type="video/mp4" />
            ${s.video.captions ? html`<track kind="captions" src="${s.video.captions}" srclang="en" label="English" default />` : ''}
          </video>`
        : s.kind === 'image' && s.image
          ? html`<img class="showcase-image" src="${s.image.src}" width="${s.image.width}" height="${s.image.height}" alt="${s.image.alt}" loading="lazy" decoding="async" />`
          : '';
  return html`<li class="showcase-item reveal" id="${s.id}">
    <article aria-labelledby="${s.id}-title">
      <p class="showcase-meta"><span class="kind kind-${s.kind}">${icon(s.kind === 'audio' ? 'voice' : s.kind === 'video' ? 'film' : 'image', 'icon icon-small')}${s.meta}</span><time datetime="${s.published}">${longDate(s.published)}</time></p>
      <h2 id="${s.id}-title">${s.title}</h2>
      <p>${s.description}</p>
      ${media}
      <p class="showcase-credit">${s.credit}${s.link ? html` · <a href="${s.link.href}">${s.link.label}${icon('external', 'icon icon-small')}</a>` : ''}</p>
    </article>
  </li>`;
}

export function showcasePage(): Html {
  const kinds = new Set(SHOWCASE.map((s) => s.kind));
  return html`${pageIntro('Showcase', 'Work made with AZ Studio', 'A small, growing selection. Everything here was published deliberately; nothing is pulled from private projects.')}

<section class="section section-tight">
  <div class="container narrow">
    ${
      SHOWCASE.length
        ? html`<ul class="showcase-list">${SHOWCASE.map(showcaseItem)}</ul>`
        : html`<div class="empty-state"><h2>Nothing to show yet</h2><p>Selected work will appear here once it has been approved for public viewing.</p></div>`
    }
    ${
      !kinds.has('video') || !kinds.has('image')
        ? html`<div class="empty-state reveal">
      <span class="highlight-icon">${icon('film')}</span>
      <h2>Films and images are on their way</h2>
      <p>Video and image work will join the showcase once pieces are chosen and cleared for public viewing. Until then, the workflows behind them are described on <a href="/explore">Explore</a>.</p>
    </div>`
        : ''
    }
    <p class="fine-print">Narration in these editions uses synthetic voices generated in AZ Studio. The players stream from this site; no audio downloads until you press play.</p>
  </div>
</section>

${ctaBand('Want to make something like this?', 'AZ Studio isn’t open to others yet. Join the early-access list to hear when invitations begin.')}`;
}

export function aboutPage(): Html {
  return html`${pageIntro('About', 'An independent project by Francis Pwavwe', 'AZ Studio started as a private workspace for one person’s creative projects. This is a little about why it exists.')}

<section class="section section-tight">
  <div class="container narrow prose">
    <h2>Why it exists</h2>
    <p>Creative projects tend to scatter. A script lives in one app, pictures in another, music and voice somewhere else, and the edit in a fourth. Keeping track of what belongs to which project — and what each experiment cost — takes energy away from the work itself.</p>
    <p>AZ Studio brings those workflows together. A project keeps its writing, images, music, narration and edit in one place, and the steps that cost money show an estimate before they run.</p>
    <h2>Room to experiment</h2>
    <p>Just as important, AZ Studio is a place to try things: a narrated film made from still images, a music video cut to the beat of a song, an essay turned into an audio edition. Some experiments become finished work. Others are quietly set aside — and that’s part of the point.</p>
    <h2>Who is behind it</h2>
    <p>Francis Pwavwe designed and built AZ Studio, and uses it for his own work. He also writes <a href="${BLOG_URL}">The Pwavwe Papers</a>, an independent blog of essays — some of which now have audio editions made in AZ Studio, which you can hear in the <a href="/showcase">showcase</a>.</p>
    <p>There’s no company or team behind AZ Studio at this stage. It runs on Google Cloud and uses Google’s generative AI models for video, images, voice and music, with its own planning, checking and editing tools around them.</p>
    <h2>What happens next</h2>
    <p>The aim is to open AZ Studio to other people gradually — first to a small number of invited people, with clear limits, then more widely if that goes well. The <a href="/explore">Explore</a> page shows what works today and what is still being prepared.</p>
  </div>
</section>

${ctaBand()}`;
}

export function earlyAccessPage(): Html {
  return html`${pageIntro('Early access', 'Join the early-access list', 'Register your interest in trying AZ Studio. We’ll introduce access gradually, in small groups, and let people on the list know first.')}

<section class="section section-tight">
  <div class="container ea-grid">
    <div class="prose ea-explainer">
      <h2>What you’re signing up for</h2>
      <ul class="check-list">
        <li>${icon('check', 'icon icon-small')}<span>A place on the list of people who’d like to try AZ Studio.</span></li>
        <li>${icon('check', 'icon icon-small')}<span>Occasional emails about early access — for example, an invitation when one is available for you.</span></li>
        <li>${icon('check', 'icon icon-small')}<span>Nothing else: no newsletter, no marketing from anyone else, no account, no charge.</span></li>
      </ul>
      <h2>Good to know</h2>
      <p>Access will be introduced gradually. Joining doesn’t guarantee an invitation, a date, or particular features or prices — none of those are decided yet.</p>
      <p>You can ask to be removed at any time through the <a href="${CONTACT_URL}">contact page</a>. The <a href="/privacy">privacy notice</a> explains exactly what is stored and for how long.</p>
    </div>

    <div class="ea-panel">
      <form class="ea-form" id="early-access-form" novalidate data-endpoint="${EARLY_ACCESS_PATH}" data-notice-version="${EARLY_ACCESS_NOTICE_VERSION}" aria-describedby="ea-intro">
        <h2 id="ea-intro" class="form-title">Your details</h2>
        <div class="field">
          <label for="ea-email">Email address <span class="field-hint">(required)</span></label>
          <input id="ea-email" name="email" type="email" autocomplete="email" inputmode="email" maxlength="${EARLY_ACCESS_LIMITS.emailMax}" required aria-describedby="ea-email-error" />
          <p class="field-error" id="ea-email-error" hidden></p>
        </div>
        <div class="field">
          <label for="ea-name">Name <span class="field-hint">(optional)</span></label>
          <input id="ea-name" name="name" type="text" autocomplete="name" maxlength="${EARLY_ACCESS_LIMITS.nameMax}" aria-describedby="ea-name-error" />
          <p class="field-error" id="ea-name-error" hidden></p>
        </div>
        <div class="field">
          <label for="ea-interest">Main creative interest <span class="field-hint">(optional)</span></label>
          <select id="ea-interest" name="interest" aria-describedby="ea-interest-error">
            <option value="">Choose one…</option>
            ${EARLY_ACCESS_INTERESTS.map((i) => html`<option value="${i.value}">${i.label}</option>`)}
          </select>
          <p class="field-error" id="ea-interest-error" hidden></p>
        </div>
        <div class="field field-check">
          <input id="ea-consent" name="consent" type="checkbox" value="yes" required aria-describedby="ea-consent-error" />
          <label for="ea-consent">${EARLY_ACCESS_CONSENT_TEXT}</label>
          <p class="field-error" id="ea-consent-error" hidden></p>
        </div>
        <div class="hp-field" aria-hidden="true">
          <label for="ea-website">Leave this field empty</label>
          <input id="ea-website" name="website" type="text" tabindex="-1" autocomplete="off" />
        </div>
        <div class="form-error" id="ea-form-error" role="alert" tabindex="-1" hidden></div>
        <button class="button button-primary button-block" type="submit" data-submit disabled>Join the early-access list</button>
        <p class="form-note">We store your details only to contact you about early access. Read the <a href="/privacy">privacy notice</a> (version ${EARLY_ACCESS_NOTICE_VERSION}).</p>
        <noscript><p class="form-error">Registration needs JavaScript. If you can’t enable it, ask to join through the <a href="${CONTACT_URL}">contact page</a>.</p></noscript>
        <p class="visually-hidden" aria-live="polite" id="ea-status"></p>
      </form>

      <div class="ea-success" id="ea-success" tabindex="-1" hidden>
        <span class="success-icon">${icon('check')}</span>
        <h2 id="ea-success-title">You’re on the list</h2>
        <p id="ea-success-body">Your registration has been saved.</p>
        <p>Access will open gradually, in small groups. Joining doesn’t guarantee an invitation or a date, and we haven’t sent a confirmation email — the next message you get from AZ Studio will be about early access.</p>
        <p>Changed your mind? Ask to be removed through the <a href="${CONTACT_URL}">contact page</a>.</p>
        <button class="button button-secondary" type="button" data-reset>Register another address</button>
      </div>
    </div>
  </div>
</section>`;
}

export function faqPage(): Html {
  return html`${pageIntro('FAQ and contact', 'Questions and answers', 'Practical answers about AZ Studio as it stands today. If something isn’t covered, get in touch.')}

<section class="section section-tight">
  <div class="container narrow">
    <div class="faq-full">
      ${FAQ.map((f, i) => html`<section class="faq-entry reveal" aria-labelledby="faq-${i}"><h2 id="faq-${i}">${f.q}</h2><p>${raw(f.a)}</p></section>`)}
    </div>
    <section class="contact-card reveal" id="contact" aria-labelledby="contact-title">
      <span class="highlight-icon">${icon('mail')}</span>
      <div>
        <h2 id="contact-title">Contact</h2>
        <p>Send feedback, questions or removal requests through the contact page on The Pwavwe Papers, Francis Pwavwe’s website. For removal from the early-access list, write from the address you registered with.</p>
        <p><a class="button button-secondary" href="${CONTACT_URL}">Open the contact page ${icon('external', 'icon icon-small')}</a></p>
      </div>
    </section>
  </div>
</section>

${ctaBand()}`;
}

export function privacyPage(): Html {
  return html`${pageIntro('Privacy notice', 'Privacy on the AZ Studio website', raw(`What this website collects, why, and what you can ask for. Version ${EARLY_ACCESS_NOTICE_VERSION}.`))}

<section class="section section-tight">
  <div class="container narrow prose">
    <h2>Who is responsible</h2>
    <p>AZ Studio is an independent project run by Francis Pwavwe. You can reach him through the <a href="${CONTACT_URL}">contact page on The Pwavwe Papers</a>.</p>
    <p>This notice covers the public pages of az-studio.web.app and the early-access list. The private studio behind the “Studio sign in” link is used only by its owner.</p>

    <h2>What we collect</h2>
    <h3>If you join the early-access list</h3>
    <ul>
      <li>Your <strong>email address</strong> (required).</li>
      <li>Your <strong>name</strong> and <strong>main creative interest</strong>, if you choose to give them.</li>
      <li>A record of your <strong>consent</strong>: that you ticked the box, when, and which version of this notice was shown.</li>
      <li>When you registered, when the form was last submitted for your address, and how many times.</li>
    </ul>
    <h3>To prevent abuse of the form</h3>
    <p>Your network (IP) address is used to limit repeated submissions. It is stored only as a keyed hash — not the address itself — and the hash is deleted after ${EARLY_ACCESS_LIMITS.rateRetentionHours} hours.</p>
    <h3>When you visit any page</h3>
    <p>Google, which hosts the site, processes the technical details every web request carries — such as your IP address, browser type and the page requested — to deliver it. Requests to the early-access form are also recorded in Google Cloud’s service logs, which are kept for 30 days.</p>
    <p>The public pages set <strong>no cookies</strong> and use <strong>no analytics, advertising or tracking</strong> tools. Fonts and scripts are served from this site. The audio players in the showcase stream from this site and Google Cloud Storage only when you press play.</p>
    <p>If you open the studio sign-in page, Google’s sign-in and reCAPTCHA services load there to protect the private studio.</p>

    <h2>Why we use it</h2>
    <p>Only to run the early-access list: to know who would like to try AZ Studio and to email you about early access, such as an invitation. We rely on your consent, which you can withdraw at any time. We don’t sell your details, share them with advertisers, or add you to any other mailing list.</p>

    <h2>Who processes it</h2>
    <p>The website and the list run on Google Cloud (Firebase Hosting, Cloud Functions and Cloud Firestore). Registrations are stored in Google’s us-central1 region in the United States, in a database that the public cannot read; only Francis can view or export them.</p>
    <p>No email service is connected yet. If one is used to send invitations, this notice will be updated before that happens.</p>

    <h2>How long we keep it</h2>
    <p>Registrations are kept while the early-access list is in use, and deleted when it is no longer needed or when you ask — whichever comes first. Hashed network addresses are deleted after ${EARLY_ACCESS_LIMITS.rateRetentionHours} hours; service logs after 30 days.</p>

    <h2>Your choices</h2>
    <p>You can ask for a copy of what is stored about you, ask for it to be corrected, or ask for it to be deleted and to be taken off the list. Use the <a href="${CONTACT_URL}">contact page</a>, writing from the address you registered with so the request can be matched. Deletion removes your registration and its consent record.</p>
    <p>If you’re unhappy with how your information is handled, please get in touch first; you may also have the right to complain to a data protection authority where you live.</p>

    <h2>Changes</h2>
    <p>If this notice changes, the version date at the top changes too. Registrations record which version was shown when you joined.</p>
  </div>
</section>`;
}

export function termsPage(): Html {
  return html`${pageIntro('Terms of use', 'Terms for this website', raw(`Plain terms for the AZ Studio website, the early-access list and the showcase during this launch phase. Version ${EARLY_ACCESS_NOTICE_VERSION}.`))}

<section class="section section-tight">
  <div class="container narrow prose">
    <h2>About these terms</h2>
    <p>These terms apply when you use the public pages of az-studio.web.app or join the early-access list. AZ Studio is an independent project run by Francis Pwavwe.</p>

    <h2>The website</h2>
    <p>The site describes a project that is still being developed. Features, plans and timings can change, and the site may be unavailable from time to time.</p>

    <h2>The early-access list</h2>
    <p>Joining is free. It doesn’t create an account and doesn’t guarantee an invitation, a launch date, or any particular feature or price. Invitations, if you receive one, may come with their own terms. The list may be changed, paused or closed.</p>
    <p>Please register only your own email address.</p>

    <h2>Showcase and site content</h2>
    <p>Unless stated otherwise, the content of this site — including the showcase work, text and design — belongs to Francis Pwavwe. You’re welcome to link to it and share those links. Please don’t copy, republish or reuse it without permission.</p>
    <p>Some showcase work is made with generative AI; where it is, the page says so.</p>

    <h2>Acceptable use</h2>
    <p>Don’t try to access the private studio or anyone else’s information, interfere with the site or the form, submit registrations automatically, or use the site in a way that breaks the law.</p>

    <h2>Responsibility</h2>
    <p>The site is provided as it is, for information. To the extent the law allows, Francis Pwavwe isn’t responsible for losses arising from using it. Nothing in these terms limits rights you have under the law that can’t be limited.</p>

    <h2>Contact and changes</h2>
    <p>Questions about these terms are welcome through the <a href="${CONTACT_URL}">contact page</a>. If the terms change, the version date above changes too.</p>
  </div>
</section>`;
}

export function notFoundPage(): Html {
  return html`<section class="page-intro not-found">
  <div class="container narrow">
    <p class="eyebrow">404 · Page not found</p>
    <h1>This page isn’t here.</h1>
    <p class="lede">The link may be out of date, or the address may have a typo. Here are some places to go instead.</p>
    <ul class="not-found-links">
      <li><a class="button button-primary" href="/">Home</a></li>
      <li><a class="button button-secondary" href="/explore">Explore AZ Studio</a></li>
      <li><a class="button button-secondary" href="/showcase">Showcase</a></li>
      <li><a class="button button-secondary" href="/faq">FAQ and contact</a></li>
    </ul>
    <p class="fine-print">Looking for the studio itself? It’s private — <a href="/studio" rel="nofollow">sign in here</a> if you have access.</p>
  </div>
</section>`;
}
