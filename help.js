// help.html has no dynamic logic — this module exists only to wire the
// service-worker registration and install-prompt machinery, the same
// way every other page does. CSP forbids inline scripts.

import './lib/register-sw.js';
import './lib/install.js';
