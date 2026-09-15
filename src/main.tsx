import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MotionConfig } from 'framer-motion'
import './index.css'
import App from './App.tsx'
import { WHEAT_EDITION, WHEAT_EDITION_PROFILE } from './wheatEdition'

/**
 * The edition, stated once on the document element.
 *
 * Every visual difference between Wheat Standard and Wheat Lightweight is a
 * token override under `:root[data-wheat-edition="lightweight"]` in
 * `styles/tokens.css`. Stamping the attribute here, before the first render, is
 * what makes that work without a single component knowing which edition it is
 * running in — and without a flash of the wrong profile on the first paint.
 */
document.documentElement.dataset.wheatEdition = WHEAT_EDITION

/**
 * Framer Motion, centrally.
 *
 * `reducedMotion="user"` is Motion's own honouring of the operating system
 * setting, and is what Standard uses. Lightweight passes `"always"`, which
 * makes every `motion` component skip its transform and opacity animation while
 * keeping the component, its layout and its accessibility exactly as they are —
 * so nothing has to be rewritten per edition, and a `prefers-reduced-motion`
 * machine is still honoured because "always" is a superset of "user".
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion={WHEAT_EDITION_PROFILE.visualProfile === 'economical' ? 'always' : 'user'}>
      <App />
    </MotionConfig>
  </StrictMode>,
)
