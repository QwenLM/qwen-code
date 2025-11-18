#!/usr/bin/env python3
"""
Analyseur de Plans Électriques - Québec
Utilise OCR (pytesseract) et vision par ordinateur (OpenCV, YOLO) pour extraire le matériel
"""

import sys
import json
import cv2
import numpy as np
import pytesseract
from PIL import Image
import re
from typing import List, Dict, Tuple

class ElectricalPlanAnalyzer:
    """Analyse de plans électriques avec OCR et vision par ordinateur"""

    def __init__(self):
        # Configuration pytesseract
        pytesseract.pytesseract.tesseract_cmd = '/usr/bin/tesseract'

        # Modèle YOLO pré-entraîné (à remplacer par modèle custom pour symboles électriques)
        # self.yolo_model = self.load_yolo_model()

        # Dictionnaire de symboles électriques québécois
        self.quebec_symbols = {
            'outlet': ['prise', 'outlet', '⏚'],
            'switch': ['inter', 'switch', 'S'],
            'light': ['luminaire', 'light', '💡', '◯'],
            'panel': ['panneau', 'panel', 'P'],
            'gfci': ['ddft', 'gfci', 'DDFT'],
            'cafci': ['cafci', 'CAFCI'],
            'stove': ['cuisinière', 'stove', '5000w', '5kw'],
            'heated_floor': ['plancher chauffant', 'heated floor', 'radiant'],
            'breaker': ['disjoncteur', 'breaker', 'CB']
        }

        # Patterns pour spécifications québécoises
        self.quebec_patterns = {
            'stove_5000w': r'(?:cuisinière|stove).*?(?:≥|>=)?\s*5000\s*w',
            'voltage_120': r'120\s*v',
            'voltage_240': r'240\s*v',
            'amperage': r'(\d+)\s*a(?:mp)?',
            'wire_size': r'(\d+(?:/\d+)?)\s*(?:awg|AWG)',
            'circuit': r'circuit\s*#?(\d+)',
        }

    def analyze_page(self, image_path: str, page_number: int) -> Dict:
        """Analyser une page de plan électrique"""
        print(f"Analyse page {page_number}: {image_path}", file=sys.stderr)

        # Charger l'image
        image = cv2.imread(image_path)
        if image is None:
            return self._empty_result(page_number)

        # Prétraitement de l'image
        processed = self.preprocess_image(image)

        # OCR - Extraction de texte
        text_data = self.extract_text_with_ocr(processed, page_number)

        # Vision - Détection d'équipements électriques
        equipment = self.detect_electrical_equipment(image, text_data, page_number)

        # Détection de symboles électriques
        symbols = self.detect_electrical_symbols(image, text_data, page_number)

        # Calcul confiance globale
        confidence = self.calculate_confidence(text_data, equipment, symbols)

        return {
            'pageNumber': page_number,
            'text': text_data,
            'equipment': equipment,
            'symbols': symbols,
            'confidence': confidence
        }

    def preprocess_image(self, image: np.ndarray) -> np.ndarray:
        """Prétraiter l'image pour améliorer l'OCR"""
        # Conversion en niveaux de gris
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

        # Augmenter le contraste
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)

        # Débruitage
        denoised = cv2.fastNlMeansDenoising(enhanced)

        # Binarisation adaptive
        binary = cv2.adaptiveThreshold(
            denoised, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY,
            11, 2
        )

        return binary

    def extract_text_with_ocr(self, image: np.ndarray, page_number: int) -> List[Dict]:
        """Extraire le texte avec pytesseract"""
        # Configuration OCR français
        custom_config = r'--oem 3 --psm 6 -l fra+eng'

        # Extraire texte avec coordonnées
        data = pytesseract.image_to_data(
            image,
            config=custom_config,
            output_type=pytesseract.Output.DICT
        )

        text_data = []
        n_boxes = len(data['text'])

        for i in range(n_boxes):
            text = data['text'][i].strip()
            conf = int(data['conf'][i])

            # Filtrer texte vide ou faible confiance
            if conf > 30 and text:
                text_data.append({
                    'text': text,
                    'coordinates': {
                        'x': int(data['left'][i]),
                        'y': int(data['top'][i])
                    },
                    'pageNumber': page_number,
                    'confidence': conf / 100.0
                })

        print(f"OCR: {len(text_data)} textes extraits", file=sys.stderr)
        return text_data

    def detect_electrical_equipment(
        self,
        image: np.ndarray,
        text_data: List[Dict],
        page_number: int
    ) -> List[Dict]:
        """Détecter équipements électriques"""
        equipment = []

        # Analyser le texte extrait pour identifier équipements
        full_text = ' '.join([t['text'] for t in text_data]).lower()

        # Détection cuisinière ≥5000W (spécifique Québec - CEQ 6-304)
        if self._match_pattern(full_text, self.quebec_patterns['stove_5000w']):
            # Trouver coordonnées dans texte
            coords = self._find_text_coordinates(text_data, ['cuisinière', 'stove', '5000'])
            equipment.append({
                'id': f'stove_{page_number}_1',
                'type': 'stove_outlet',
                'specifications': {
                    'power': '≥5000W',
                    'voltage': '240V',
                    'amperage': '40A minimum',
                    'ceq_reference': 'CEQ 6-304'
                },
                'coordinates': coords,
                'pageNumber': page_number,
                'confidence': 0.85,
                'csaCertificationRequired': True
            })

        # Détection prises standards
        outlet_keywords = ['prise', 'outlet', 'duplex']
        outlet_coords = self._find_text_coordinates(text_data, outlet_keywords)
        if outlet_coords['x'] > 0:
            equipment.append({
                'id': f'outlet_{page_number}_1',
                'type': 'outlet',
                'specifications': {
                    'amperage': '15A',
                    'voltage': '120V',
                    'type': 'Duplex avec mise à la terre'
                },
                'coordinates': outlet_coords,
                'pageNumber': page_number,
                'confidence': 0.75,
                'csaCertificationRequired': True
            })

        # Détection DDFT/GFCI (CEQ 26-700)
        gfci_keywords = ['ddft', 'gfci']
        gfci_coords = self._find_text_coordinates(text_data, gfci_keywords)
        if gfci_coords['x'] > 0:
            equipment.append({
                'id': f'gfci_{page_number}_1',
                'type': 'gfci_breaker',
                'specifications': {
                    'amperage': '20A',
                    'type': 'DDFT (Disjoncteur différentiel)',
                    'ceq_reference': 'CEQ 26-700'
                },
                'coordinates': gfci_coords,
                'pageNumber': page_number,
                'confidence': 0.90,
                'csaCertificationRequired': True
            })

        # Détection planchers chauffants (CEQ 62-116)
        floor_keywords = ['plancher chauffant', 'heated floor', 'radiant']
        floor_coords = self._find_text_coordinates(text_data, floor_keywords)
        if floor_coords['x'] > 0:
            equipment.append({
                'id': f'heated_floor_{page_number}_1',
                'type': 'heated_floor',
                'specifications': {
                    'power': '150W/pi² typical',
                    'control': 'Thermostat avec sonde requis',
                    'ceq_reference': 'CEQ 62-116'
                },
                'coordinates': floor_coords,
                'pageNumber': page_number,
                'confidence': 0.80,
                'csaCertificationRequired': True
            })

        # Détection panneaux
        panel_keywords = ['panneau', 'panel', 'distribution']
        panel_coords = self._find_text_coordinates(text_data, panel_keywords)
        if panel_coords['x'] > 0:
            # Extraire amperage si mentionné
            amperage = self._extract_amperage(text_data, panel_coords)
            equipment.append({
                'id': f'panel_{page_number}_1',
                'type': 'panel',
                'specifications': {
                    'amperage': amperage or '200A',
                    'voltage': '240V',
                    'type': 'Panneau de distribution'
                },
                'coordinates': panel_coords,
                'pageNumber': page_number,
                'confidence': 0.85,
                'csaCertificationRequired': True
            })

        print(f"Équipements détectés: {len(equipment)}", file=sys.stderr)
        return equipment

    def detect_electrical_symbols(
        self,
        image: np.ndarray,
        text_data: List[Dict],
        page_number: int
    ) -> List[Dict]:
        """Détecter symboles électriques dans l'image"""
        symbols = []

        # Conversion en niveaux de gris
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

        # Détection de cercles (luminaires, prises)
        circles = cv2.HoughCircles(
            gray,
            cv2.HOUGH_GRADIENT,
            dp=1,
            minDist=20,
            param1=50,
            param2=30,
            minRadius=5,
            maxRadius=30
        )

        if circles is not None:
            circles = np.uint16(np.around(circles))
            for i, circle in enumerate(circles[0, :]):
                x, y, r = circle
                symbols.append({
                    'symbolType': 'circle_symbol',  # Pourrait être prise ou luminaire
                    'coordinates': {'x': int(x), 'y': int(y)},
                    'pageNumber': page_number,
                    'confidence': 0.70,
                    'relatedEquipment': None
                })

        # Détection de lignes (fils, conduits)
        edges = cv2.Canny(gray, 50, 150, apertureSize=3)
        lines = cv2.HoughLinesP(
            edges,
            rho=1,
            theta=np.pi/180,
            threshold=100,
            minLineLength=50,
            maxLineGap=10
        )

        line_count = len(lines) if lines is not None else 0
        print(f"Symboles détectés: {len(symbols)}, Lignes: {line_count}", file=sys.stderr)

        return symbols

    def calculate_confidence(
        self,
        text_data: List[Dict],
        equipment: List[Dict],
        symbols: List[Dict]
    ) -> float:
        """Calculer score de confiance global"""
        if not text_data and not equipment:
            return 0.0

        # Confiance moyenne OCR
        ocr_conf = np.mean([t['confidence'] for t in text_data]) if text_data else 0

        # Confiance moyenne équipements
        eq_conf = np.mean([e['confidence'] for e in equipment]) if equipment else 0

        # Confiance moyenne symboles
        sym_conf = np.mean([s['confidence'] for s in symbols]) if symbols else 0

        # Pondération: OCR 40%, équipements 40%, symboles 20%
        overall = (ocr_conf * 0.4) + (eq_conf * 0.4) + (sym_conf * 0.2)

        return round(overall, 2)

    # Méthodes utilitaires

    def _empty_result(self, page_number: int) -> Dict:
        """Retourner résultat vide"""
        return {
            'pageNumber': page_number,
            'text': [],
            'equipment': [],
            'symbols': [],
            'confidence': 0.0
        }

    def _match_pattern(self, text: str, pattern: str) -> bool:
        """Vérifier si pattern correspond au texte"""
        return re.search(pattern, text, re.IGNORECASE) is not None

    def _find_text_coordinates(self, text_data: List[Dict], keywords: List[str]) -> Dict:
        """Trouver coordonnées du texte contenant keywords"""
        for text_item in text_data:
            text_lower = text_item['text'].lower()
            if any(kw.lower() in text_lower for kw in keywords):
                return {
                    'x': text_item['coordinates']['x'],
                    'y': text_item['coordinates']['y'],
                    'width': 50,
                    'height': 20
                }

        return {'x': 0, 'y': 0, 'width': 0, 'height': 0}

    def _extract_amperage(self, text_data: List[Dict], near_coords: Dict) -> str:
        """Extraire ampérage près de coordonnées données"""
        # Chercher texte proche des coordonnées
        threshold = 100  # pixels

        for text_item in text_data:
            dx = abs(text_item['coordinates']['x'] - near_coords['x'])
            dy = abs(text_item['coordinates']['y'] - near_coords['y'])

            if dx < threshold and dy < threshold:
                # Chercher pattern ampérage
                match = re.search(self.quebec_patterns['amperage'], text_item['text'], re.IGNORECASE)
                if match:
                    return f"{match.group(1)}A"

        return None


def main():
    """Point d'entrée du script"""
    if len(sys.argv) < 4:
        print("Usage: python3 plan_analyzer.py analyze-page <image_path> <page_number>", file=sys.stderr)
        sys.exit(1)

    command = sys.argv[1]

    if command == 'analyze-page':
        image_path = sys.argv[2]
        page_number = int(sys.argv[3])

        analyzer = ElectricalPlanAnalyzer()
        result = analyzer.analyze_page(image_path, page_number)

        # Retourner JSON sur stdout
        print(json.dumps(result, ensure_ascii=False, indent=2))

    else:
        print(f"Commande inconnue: {command}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
