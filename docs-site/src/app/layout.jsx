import { Footer, Layout, Navbar } from 'nextra-theme-docs';
import { Banner, Head } from 'nextra/components';
import { getPageMap } from 'nextra/page-map';
import 'nextra-theme-docs/style.css';

export const metadata = {
  // Define your metadata here
  // For more information on metadata API, see: https://nextjs.org/docs/app/building-your-application/optimizing/metadata
};

const banner = (
  <Banner storageKey="some-key">Qwen Code 0.5.0 is released 🎉</Banner>
);
const navbar = (
  <Navbar
    logo={<b>Qwen Code</b>}
    // ... Your additional navbar options
  />
);
const footer = <Footer>MIT {new Date().getFullYear()} © Qwen Team.</Footer>;

export default async function RootLayout({ children }) {
  return (
    <html
      // Not required, but good for SEO
      lang="en"
      // Required to be set
      dir="ltr"
      // Suggested by `next-themes` package https://github.com/pacocoursey/next-themes#with-app
      suppressHydrationWarning
    >
      <Head
      // ... Your additional head options
      >
        {/* Your additional tags should be passed as `children` of `<Head>` element */}
      </Head>
      <body>
        <Layout
          banner={banner}
          navbar={navbar}
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/QwenLM/qwen-code/docs"
          // Use a very large finite integer to expand all folders by default.
          // (Some schema validators reject `Infinity`.)
          sidebar={{ defaultMenuCollapseLevel: 9999 }}
          footer={footer}
          search={false}
          // ... Your additional layout options
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
