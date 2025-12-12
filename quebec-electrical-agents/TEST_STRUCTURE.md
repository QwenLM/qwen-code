# Structure des Tests - Système d'agents électriques québécois

## Répertoire principal
```
test/
├── integration/
│   ├── sample_plans/
│   │   ├── residential_house.pdf          # Maison unifamiliale
│   │   ├── commercial_office.pdf         # Bureau commercial
│   │   ├── industrial_factory.pdf        # Usine industrielle
│   │   └── apartment_complex.pdf         # Complexe d'appartements
│   ├── test_scripts/
│   │   ├── test_residential.js           # Test maison unifamiliale
│   │   ├── test_commercial.js            # Test bureau commercial
│   │   ├── test_industrial.js            # Test usine industrielle
│   │   └── test_apartment_complex.js     # Test complexe d'appartements
│   ├── validators/
│   │   ├── ceq_compliance_validator.js   # Validateur de conformité CEQ
│   │   ├── material_recognition_validator.js # Validateur de reconnaissance de matériel
│   │   └── dashboard_functionality_validator.js # Validateur du dashboard
│   └── reports/
│       └── test_results.json             # Résultats des tests
└── unit/
    ├── services/
    │   ├── faiss_service.test.js
    │   ├── knowledge_base_service.test.js
    │   └── quebec_standards_service.test.js
    ├── controllers/
    │   ├── plan_controller.test.js
    │   └── knowledge_controller.test.js
    └── models/
        ├── knowledge_chunk.test.js
        └── detected_equipment.test.js
```