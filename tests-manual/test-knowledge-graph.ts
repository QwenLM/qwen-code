#!/usr/bin/env tsx
/**
 * Teste do Knowledge Graph System
 */

import { createCodebaseAnalyzer } from '../packages/core/src/intelligence/codebase-graph.js';

async function test() {
  console.log('🧪 Testando Knowledge Graph System...\n');

  const analyzer = createCodebaseAnalyzer();

  // Construir grafo do projeto atual
  console.log('📊 Construindo grafo do codebase...');
  const graph = await analyzer.buildGraph(process.cwd());

  console.log(`✅ Arquivos analisados: ${graph.nodes.size}`);
  console.log(`✅ Arquitetura detectada: ${graph.metadata.architecture}`);
  console.log(
    `✅ Linguagens: ${graph.metadata.techStack.languages.join(', ')}`,
  );
  console.log(
    `✅ Frameworks: ${graph.metadata.techStack.frameworks.join(', ')}\n`,
  );

  // Testar análise de impacto
  if (graph.nodes.size > 0) {
    const files = Array.from(graph.nodes.keys()).slice(0, 3);
    console.log(
      `📈 Analisando impacto de mudanças em ${files.length} arquivos...`,
    );

    const impact = await analyzer.getImpactAnalysis(files);
    console.log(`✅ Nível de risco: ${impact.riskLevel}`);
    console.log(`✅ Arquivos afetados: ${impact.affectedFiles.length}`);
    console.log(
      `✅ Linhas de código afetadas: ${impact.estimatedScope.linesOfCode}`,
    );

    if (impact.recommendations.length > 0) {
      console.log('\n💡 Recomendações:');
      impact.recommendations.forEach((rec, i) => {
        console.log(`   ${i + 1}. ${rec}`);
      });
    }
  }

  console.log('\n✨ Knowledge Graph System funcionando perfeitamente!\n');
}

test().catch((error) => {
  console.error('❌ Erro:', error);
  process.exit(1);
});
