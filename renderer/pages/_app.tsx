import '../styles/globals.css';
import 'xterm/css/xterm.css';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/ariakit/style.css';
import type { AppProps } from 'next/app';

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
