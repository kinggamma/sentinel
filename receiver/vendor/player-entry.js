/**
 * Bundle entry for the replay player.
 *
 * The viewer is a plain static page with a strict CSP and no CDN access, so
 * rrweb-player is bundled into a single self-contained ES module at image
 * build time (see the assets stage in the Dockerfile) and exposed on window.
 */
import rrwebPlayer from "rrweb-player";

window.rrwebPlayer = rrwebPlayer;

export default rrwebPlayer;
