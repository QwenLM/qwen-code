import { generateStaticParamsFor, importPage } from 'nextra/pages';
import { notFound } from 'next/navigation';
import { useMDXComponents as getMDXComponents } from '../../../mdx-components';
import { filterPublicStaticParams, isPublicDocsPath } from '../public-docs';

const generateAllStaticParams = generateStaticParamsFor('mdxPath');

export const dynamicParams = false;

export async function generateStaticParams(...args) {
  const staticParams = await generateAllStaticParams(...args);
  return filterPublicStaticParams(staticParams);
}

export async function generateMetadata(props) {
  const params = await props.params;
  if (!isPublicDocsPath(params.mdxPath)) {
    notFound();
  }

  const { metadata } = await importPage(params.mdxPath);
  return metadata;
}

const Wrapper = getMDXComponents().wrapper;

export default async function Page(props) {
  const params = await props.params;
  if (!isPublicDocsPath(params.mdxPath)) {
    notFound();
  }

  const {
    default: MDXContent,
    toc,
    metadata,
    sourceCode,
  } = await importPage(params.mdxPath);
  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      <MDXContent {...props} params={params} />
    </Wrapper>
  );
}
