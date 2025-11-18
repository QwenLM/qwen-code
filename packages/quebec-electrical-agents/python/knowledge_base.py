#!/usr/bin/env python3
"""
Base de Connaissances FAISS - Normes Électriques Québécoises
Indexation vectorielle des normes CEQ, RBQ, RSST, CSA
"""

import faiss
import numpy as np
import json
import pickle
from sentence_transformers import SentenceTransformer
from typing import List, Dict, Tuple
from pathlib import Path
import sys


class ElectricalKnowledgeBase:
    """Base de connaissances vectorielle pour normes électriques québécoises"""

    def __init__(self, model_name: str = 'distiluse-base-multilingual-cased-v2'):
        """
        Initialiser la base de connaissances

        Args:
            model_name: Modèle de sentence transformers (multilingue pour FR/EN)
        """
        print(f"Initialisation modèle: {model_name}", file=sys.stderr)
        self.model = SentenceTransformer(model_name)
        self.dimension = self.model.get_sentence_embedding_dimension()

        # Index FAISS (Inner Product pour cosine similarity après normalisation)
        self.index = faiss.IndexFlatIP(self.dimension)

        # Métadonnées des documents indexés
        self.metadata = []

        # Compteur de documents
        self.doc_count = 0

    def add_documents(
        self,
        texts: List[str],
        metadata_list: List[Dict],
        batch_size: int = 32
    ) -> None:
        """
        Ajouter des documents à la base de connaissances

        Args:
            texts: Liste de textes à indexer
            metadata_list: Métadonnées correspondantes (source, section, etc.)
            batch_size: Taille des lots pour embedding
        """
        print(f"Ajout de {len(texts)} documents...", file=sys.stderr)

        # Générer embeddings par lots
        all_embeddings = []
        for i in range(0, len(texts), batch_size):
            batch_texts = texts[i:i + batch_size]
            batch_embeddings = self.model.encode(
                batch_texts,
                convert_to_numpy=True,
                show_progress_bar=True
            )
            all_embeddings.append(batch_embeddings)

        # Concaténer tous les embeddings
        embeddings = np.vstack(all_embeddings).astype('float32')

        # Normaliser pour cosine similarity
        faiss.normalize_L2(embeddings)

        # Ajouter à l'index FAISS
        self.index.add(embeddings)

        # Ajouter métadonnées
        self.metadata.extend(metadata_list)

        self.doc_count += len(texts)
        print(f"Total documents indexés: {self.doc_count}", file=sys.stderr)

    def search(
        self,
        query: str,
        k: int = 5,
        filter_source: str = None
    ) -> List[Dict]:
        """
        Rechercher dans la base de connaissances

        Args:
            query: Question ou requête
            k: Nombre de résultats à retourner
            filter_source: Filtrer par source (CEQ, RBQ, RSST, CSA)

        Returns:
            Liste de résultats avec scores et métadonnées
        """
        # Générer embedding de la requête
        query_embedding = self.model.encode([query], convert_to_numpy=True).astype('float32')

        # Normaliser
        faiss.normalize_L2(query_embedding)

        # Rechercher dans l'index
        scores, indices = self.index.search(query_embedding, k * 2)  # Rechercher plus pour filtrage

        # Construire résultats
        results = []
        for score, idx in zip(scores[0], indices[0]):
            if idx < 0 or idx >= len(self.metadata):
                continue

            metadata = self.metadata[idx]

            # Filtrer par source si demandé
            if filter_source and metadata.get('source') != filter_source:
                continue

            results.append({
                'text': metadata['text'],
                'source': metadata['source'],
                'section': metadata.get('section', ''),
                'category': metadata.get('category', ''),
                'score': float(score),
                'metadata': metadata
            })

            # Arrêter si on a assez de résultats après filtrage
            if len(results) >= k:
                break

        return results

    def search_by_category(
        self,
        query: str,
        category: str,
        k: int = 5
    ) -> List[Dict]:
        """
        Rechercher par catégorie spécifique

        Args:
            query: Question
            category: Catégorie (safety, wiring, grounding, etc.)
            k: Nombre de résultats

        Returns:
            Résultats filtrés par catégorie
        """
        # Rechercher plus large
        all_results = self.search(query, k=k*3)

        # Filtrer par catégorie
        filtered = [r for r in all_results if r['category'] == category]

        return filtered[:k]

    def get_quebec_specific_knowledge(
        self,
        query: str,
        k: int = 5
    ) -> List[Dict]:
        """
        Récupérer connaissances spécifiques au Québec

        Args:
            query: Question
            k: Nombre de résultats

        Returns:
            Résultats avec focus sur spécificités québécoises
        """
        # Rechercher
        results = self.search(query, k=k*2)

        # Prioriser résultats québécois
        quebec_results = []
        other_results = []

        for result in results:
            tags = result['metadata'].get('tags', [])
            if any(tag in ['quebec', 'ceq', 'rbq', 'rsst', 'hydro-quebec'] for tag in tags):
                quebec_results.append(result)
            else:
                other_results.append(result)

        # Combiner avec priorité québécoise
        return (quebec_results + other_results)[:k]

    def save(self, index_path: str, metadata_path: str) -> None:
        """
        Sauvegarder l'index et les métadonnées

        Args:
            index_path: Chemin pour l'index FAISS
            metadata_path: Chemin pour les métadonnées
        """
        print(f"Sauvegarde index: {index_path}", file=sys.stderr)
        faiss.write_index(self.index, index_path)

        print(f"Sauvegarde metadata: {metadata_path}", file=sys.stderr)
        with open(metadata_path, 'wb') as f:
            pickle.dump(self.metadata, f)

        print("Sauvegarde complétée", file=sys.stderr)

    def load(self, index_path: str, metadata_path: str) -> None:
        """
        Charger un index et métadonnées existants

        Args:
            index_path: Chemin de l'index FAISS
            metadata_path: Chemin des métadonnées
        """
        print(f"Chargement index: {index_path}", file=sys.stderr)
        self.index = faiss.read_index(index_path)

        print(f"Chargement metadata: {metadata_path}", file=sys.stderr)
        with open(metadata_path, 'rb') as f:
            self.metadata = pickle.load(f)

        self.doc_count = len(self.metadata)
        print(f"Index chargé: {self.doc_count} documents", file=sys.stderr)


def initialize_quebec_knowledge_base() -> ElectricalKnowledgeBase:
    """Initialiser et peupler la base de connaissances québécoise"""

    kb = ElectricalKnowledgeBase()

    print("Initialisation base de connaissances québécoise...", file=sys.stderr)

    # Documents CEQ (Code Électrique du Québec)
    ceq_documents = [
        {
            'text': "CEQ Section 6-304: Les cuisinières électriques de 5000W ou plus doivent avoir un circuit dédié de 40A minimum.",
            'source': 'CEQ',
            'section': '6-304',
            'category': 'appliances',
            'tags': ['quebec', 'ceq', 'stove', 'cooking']
        },
        {
            'text': "CEQ Section 26-700: Protection DDFT (disjoncteur différentiel) obligatoire dans salles de bain, cuisines (prises comptoirs), extérieur, garage et sous-sol.",
            'source': 'CEQ',
            'section': '26-700',
            'category': 'safety',
            'tags': ['quebec', 'ceq', 'gfci', 'ddft', 'protection']
        },
        {
            'text': "CEQ Section 26-724: Protection CAFCI (disjoncteur anti-arc) obligatoire pour tous les circuits de chambres à coucher.",
            'source': 'CEQ',
            'section': '26-724',
            'category': 'safety',
            'tags': ['quebec', 'ceq', 'cafci', 'arc-fault', 'bedroom']
        },
        {
            'text': "CEQ Section 62-116: Les planchers chauffants électriques doivent être contrôlés par thermostat avec sonde de température et protection appropriée.",
            'source': 'CEQ',
            'section': '62-116',
            'category': 'heating',
            'tags': ['quebec', 'ceq', 'heated-floor', 'radiant', 'thermostat']
        },
        {
            'text': "CEQ Section 10-700: Système de mise à la terre requis avec résistance maximale de 25 ohms. Électrode de terre et conducteur de liaison conformes aux Tables 16 et 17.",
            'source': 'CEQ',
            'section': '10-700',
            'category': 'grounding',
            'tags': ['quebec', 'ceq', 'grounding', 'earthing', 'safety']
        },
        {
            'text': "CEQ Section 8-200: Calcul de charge pour habitations - Premier 90m² à 5000W, puis 1000W par tranche additionnelle de 90m².",
            'source': 'CEQ',
            'section': '8-200',
            'category': 'calculations',
            'tags': ['quebec', 'ceq', 'load-calculation', 'residential']
        },
        {
            'text': "CEQ Table 2: Dimensionnement des conducteurs selon l'ampérage et le type de câble. Cuivre et aluminium, températures 60°C, 75°C, 90°C.",
            'source': 'CEQ',
            'section': 'Table 2',
            'category': 'wiring',
            'tags': ['quebec', 'ceq', 'wire-sizing', 'conductors']
        },
        {
            'text': "CEQ Section 12-500: Protection mécanique des câbles requise. Câbles doivent être protégés contre dommages physiques.",
            'source': 'CEQ',
            'section': '12-500',
            'category': 'installation',
            'tags': ['quebec', 'ceq', 'cable-protection', 'mechanical']
        },
        {
            'text': "CEQ Section 2-100: Tous les circuits doivent être clairement identifiés et étiquetés au panneau de distribution.",
            'source': 'CEQ',
            'section': '2-100',
            'category': 'labeling',
            'tags': ['quebec', 'ceq', 'labeling', 'identification']
        }
    ]

    # Documents RSST (Règlement Santé et Sécurité du Travail)
    rsst_documents = [
        {
            'text': "RSST Article 185: Protection contre les chocs électriques - Mise à la terre et protection différentielle obligatoires. Distances de sécurité à respecter.",
            'source': 'RSST',
            'section': 'Article 185',
            'category': 'safety',
            'tags': ['quebec', 'rsst', 'electrical-safety', 'shock-protection']
        },
        {
            'text': "RSST Article 177: Espace de travail sécuritaire devant équipements électriques. Minimum 1 mètre de dégagement requis.",
            'source': 'RSST',
            'section': 'Article 177',
            'category': 'safety',
            'tags': ['quebec', 'rsst', 'working-space', 'clearance']
        },
        {
            'text': "RSST Articles 185-187: Procédures de cadenassage obligatoires pour maintenance d'équipements électriques. Isolement des sources d'énergie.",
            'source': 'RSST',
            'section': 'Articles 185-187',
            'category': 'safety',
            'tags': ['quebec', 'rsst', 'lockout-tagout', 'cadenassage']
        },
        {
            'text': "RSST: Équipements de protection individuelle (EPI) requis - casque, gants isolants, lunettes, chaussures de sécurité pour travaux électriques.",
            'source': 'RSST',
            'section': 'General',
            'category': 'safety',
            'tags': ['quebec', 'rsst', 'ppe', 'epi', 'safety-equipment']
        }
    ]

    # Documents RBQ (Régie du Bâtiment du Québec)
    rbq_documents = [
        {
            'text': "RBQ: Licence de maître électricien obligatoire pour tous travaux électriques. Supervision et responsabilité légale du titulaire.",
            'source': 'RBQ',
            'section': 'Licence',
            'category': 'regulatory',
            'tags': ['quebec', 'rbq', 'license', 'master-electrician']
        },
        {
            'text': "RBQ: Permis de travaux électriques requis avant début de chantier. Demande à soumettre à la municipalité.",
            'source': 'RBQ',
            'section': 'Permis',
            'category': 'regulatory',
            'tags': ['quebec', 'rbq', 'permit', 'authorization']
        },
        {
            'text': "RBQ: Inspection municipale obligatoire avant mise sous tension. Certificat de conformité requis.",
            'source': 'RBQ',
            'section': 'Inspection',
            'category': 'regulatory',
            'tags': ['quebec', 'rbq', 'inspection', 'compliance']
        },
        {
            'text': "RBQ: Formation continue de 8 heures par année obligatoire pour maîtres électriciens. Maintien des compétences.",
            'source': 'RBQ',
            'section': 'Formation',
            'category': 'training',
            'tags': ['quebec', 'rbq', 'continuing-education', 'training']
        }
    ]

    # Documents CSA (Canadian Standards Association)
    csa_documents = [
        {
            'text': "CSA C22.1: Tous équipements électriques doivent porter marque CSA, UL ou équivalent reconnu. Certification obligatoire.",
            'source': 'CSA',
            'section': 'C22.1',
            'category': 'certification',
            'tags': ['csa', 'certification', 'approval']
        },
        {
            'text': "CSA: Équipements extérieurs au Québec doivent être certifiés pour températures extrêmes -40°C à +40°C. Protection IP65 minimum.",
            'source': 'CSA',
            'section': 'Outdoor',
            'category': 'certification',
            'tags': ['quebec', 'csa', 'cold-rated', 'outdoor', 'temperature']
        },
        {
            'text': "CSA C22.1: Câbles NMD90 (Loomex) standard pour installations résidentielles au Canada. Résistant à 90°C.",
            'source': 'CSA',
            'section': 'C22.1',
            'category': 'wiring',
            'tags': ['csa', 'cable', 'nmd90', 'loomex']
        }
    ]

    # Spécificités Québec
    quebec_specific = [
        {
            'text': "Hydro-Québec: Branchement électrique nécessite approbation Hydro-Québec pour nouveau service ou augmentation de puissance.",
            'source': 'Hydro-Québec',
            'section': 'Connection',
            'category': 'regulatory',
            'tags': ['quebec', 'hydro-quebec', 'service-connection']
        },
        {
            'text': "Québec Hiver: Conditions hivernales sévères (-40°C). Équipements extérieurs doivent résister gel, neige, glace. Chauffage anti-gel recommandé pour panneaux extérieurs.",
            'source': 'Quebec Climate',
            'section': 'Winter',
            'category': 'environmental',
            'tags': ['quebec', 'winter', 'cold', 'climate']
        },
        {
            'text': "Québec: Tension standard 120/240V. Fréquence 60Hz. Compatible normes nord-américaines.",
            'source': 'Quebec Standards',
            'section': 'Voltage',
            'category': 'electrical-system',
            'tags': ['quebec', 'voltage', 'frequency']
        }
    ]

    # Combiner tous les documents
    all_documents = (
        ceq_documents +
        rsst_documents +
        rbq_documents +
        csa_documents +
        quebec_specific
    )

    # Extraire textes et métadonnées
    texts = [doc['text'] for doc in all_documents]
    metadata = all_documents

    # Ajouter à la base de connaissances
    kb.add_documents(texts, metadata)

    print(f"Base de connaissances initialisée: {len(all_documents)} documents", file=sys.stderr)

    return kb


def main():
    """Point d'entrée du script"""

    if len(sys.argv) < 2:
        print("Usage:", file=sys.stderr)
        print("  python3 knowledge_base.py init", file=sys.stderr)
        print("  python3 knowledge_base.py search <query> [source] [k]", file=sys.stderr)
        print("  python3 knowledge_base.py quebec-search <query> [k]", file=sys.stderr)
        sys.exit(1)

    command = sys.argv[1]

    # Chemins de sauvegarde
    base_dir = Path(__file__).parent.parent / 'data'
    base_dir.mkdir(exist_ok=True)
    index_path = str(base_dir / 'knowledge_index.faiss')
    metadata_path = str(base_dir / 'knowledge_metadata.pkl')

    if command == 'init':
        # Initialiser et sauvegarder
        kb = initialize_quebec_knowledge_base()
        kb.save(index_path, metadata_path)
        print(json.dumps({'status': 'success', 'documents': kb.doc_count}))

    elif command == 'search':
        if len(sys.argv) < 3:
            print("Requête manquante", file=sys.stderr)
            sys.exit(1)

        query = sys.argv[2]
        source = sys.argv[3] if len(sys.argv) > 3 else None
        k = int(sys.argv[4]) if len(sys.argv) > 4 else 5

        # Charger base de connaissances
        kb = ElectricalKnowledgeBase()
        kb.load(index_path, metadata_path)

        # Rechercher
        results = kb.search(query, k=k, filter_source=source)

        # Retourner JSON
        print(json.dumps(results, ensure_ascii=False, indent=2))

    elif command == 'quebec-search':
        if len(sys.argv) < 3:
            print("Requête manquante", file=sys.stderr)
            sys.exit(1)

        query = sys.argv[2]
        k = int(sys.argv[3]) if len(sys.argv) > 3 else 5

        # Charger base de connaissances
        kb = ElectricalKnowledgeBase()
        kb.load(index_path, metadata_path)

        # Recherche spécifique Québec
        results = kb.get_quebec_specific_knowledge(query, k=k)

        # Retourner JSON
        print(json.dumps(results, ensure_ascii=False, indent=2))

    else:
        print(f"Commande inconnue: {command}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
