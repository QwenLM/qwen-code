import { Footer, Layout, Navbar } from 'nextra-theme-docs';
import { Head } from 'nextra/components';
import { getPageMap } from 'nextra/page-map';
import 'nextra-theme-docs/style.css';

export const metadata = {
  title: 'Proto Docs',
  description:
    'Documentation for Proto — the multi-model AI agent for the terminal.',
};

const navbar = <Navbar logo={<b>Proto Docs</b>} />;
const footer = <Footer>MIT {new Date().getFullYear()} © protoLabs.</Footer>;

export default async function RootLayout({ children }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          navbar={navbar}
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/protoLabsAI/protoCLI/tree/main/docs"
          sidebar={{ defaultMenuCollapseLevel: 9999 }}
          footer={footer}
          search={false}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
