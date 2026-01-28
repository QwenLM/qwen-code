```
import {
    ZVecCollection,
    ZVecCollectionSchema,
    ZVecCreateAndOpen,
    ZVecDataType,
    ZVecDoc,
    ZVecFieldSchema,
    ZVecIndexType,
    ZVecInitOptions,
    ZVecInitialize,
    ZVecLogLevel,
    ZVecLogType,
    ZVecMetricType,
    ZVecVectorSchema
} from 'zvec';


// --- 1. Global Initialization ---
const initOptions: ZVecInitOptions = {
    logType: ZVecLogType.CONSOLE,
    logLevel: ZVecLogLevel.WARN,
};
// Configure global settings for Zvec. If not called, Zvec uses reasonable default settings.
ZVecInitialize(initOptions);


// --- 2. Create and open a collection ---

// --- 2.1 Define collection schema ---

// --- 2.1.1 Define vector fields ---
const imageVector: ZVecVectorSchema = {
    name: "imageVector", // Name of the vector field
    dataType: ZVecDataType.VECTOR_FP32, // Dense vector using fp32 precision
    dimension: 10,
    indexParams: {
        indexType: ZVecIndexType.HNSW, // Use HNSW index for faster vector query
        metricType: ZVecMetricType.COSINE, // Use the metric that the embedding model is trained for
    }
};

const keywordVector: ZVecVectorSchema = {
    name: "keywordVector", // Name of the vector field
    dataType: ZVecDataType.SPARSE_VECTOR_FP32, // Sparse vector using fp32 precision
    indexParams: {
        indexType: ZVecIndexType.HNSW, // Use HNSW index for faster vector query
        metricType: ZVecMetricType.IP,
    }
};

// --- 2.1.2 Define scalar fields ---
const productDescription: ZVecFieldSchema = {
    name: "productDescription",
    dataType: ZVecDataType.STRING, // Use STRING for description
    nullable: true, // Description can be omitted
};

const imageURL: ZVecFieldSchema = {
    name: "imageURL",
    dataType: ZVecDataType.STRING,
    nullable: false,
};

const price: ZVecFieldSchema = {
    name: "price",
    dataType: ZVecDataType.DOUBLE,
    nullable: false,
    indexParams: {
        indexType: ZVecIndexType.INVERT, // Use inverted index for faster query
        enableRangeOptimization: true,
    }
};

// --- 2.1.3 Create collection schema ---
// Combine the defined vector and scalar fields into a single collection schema.
const collectionSchema = new ZVecCollectionSchema({
    name: "products",   // Name of the collection
    vectors: [imageVector, keywordVector], // Array of vectors
    fields: [productDescription, imageURL, price], // Array of scalar fields
});
console.log(collectionSchema.toString());

// --- 2.2 Create collection with path and schema ---
const collectionPath = "./collection_example";
let collection: ZVecCollection;
try {
    // This function creates a new Collection at the specified path. It throws an exception if it
    // fails to create the collection, for example, the path already exists.
    // If you have already created the collection, please ZVecOpen() instead.
    collection = ZVecCreateAndOpen(collectionPath, collectionSchema);
    // collection = ZVecOpen(collectionPath);
    console.log("Successfully created/opened collection at ", collection.path);
    console.log("Initial Collection stats: ", collection.stats);
} catch (error) {
    console.error("Failed to create collection at path '", collectionPath, "', error: ", error);
    process.exit(1);
}


// --- 3. Insert Documents into the Collection ---
// --- 3.1 Insert a single document ---
const doc1: ZVecDoc = {
    id: "doc_1",
    vectors: {
        "imageVector": new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]), // Typed array
        "keywordVector": { 1: 0.1, 3: 0.2, 5: 0.3 },
    },
    fields: {
        "productDescription": "A high-quality camera",
        "imageURL": "https://example.com/camera.jpg",
        "price": 299.99
    }
};
const result = collection.insert(doc1);
console.log("\nSingle insertion result: ", result);
if (result.ok) {
    console.log("Successfully inserted a doc");
} else {
    // The insert() operation might fail due to duplicate id.
    // Please use upsert() if you want to overwrite existing document.
    console.log("Failed to inserted a doc");
    process.exit(1);
}

// --- 3.2 Insert a batch of documents ---
const doc2: ZVecDoc = {
    id: "doc_2",
    vectors: {
        "imageVector": [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1], // Standard array
        "keywordVector": { 2: 0.1, 4: 0.2, 6: 0.3 },
    },
    fields: {
        "productDescription": "An advanced smartphone",
        "imageURL": "https://example.com/smartphone.jpg",
        "price": 799.99
    }
};
const doc3: ZVecDoc = {
    id: "doc_3",
    vectors: {
        "imageVector": new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
        "keywordVector": { 1: 0.5, 2: 0.5, 3: 0.5 },
    },
    fields: {
        "productDescription": "A versatile laptop",
        "imageURL": "https://example.com/laptop.jpg",
        "price": 1799.99
    }
};
const doc4: ZVecDoc = {
    id: "doc_4",
    vectors: {
        "imageVector": [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
        "keywordVector": { 4: 0.5, 5: 0.5, 6: 0.5 },
    },
    fields: {
        "productDescription": "Another laptop",
        "imageURL": "https://example.com/laptop2.jpg",
        "price": 1899.99
    }
};

const batchResult = collection.insert([doc2, doc3, doc4]);
console.log("\nBatch insertion result: ", batchResult);
// --- 4. Fetch documents from the collection ---
const fetchResult1 = collection.fetch("doc_1");
console.log("\nFetch result for 'doc_1':", fetchResult1["doc_1"]);

const fetchResult2 = collection.fetch(["doc_2", "doc_3"]);
console.log("\nFetch result for 'doc_2':", fetchResult2["doc_2"]);
console.log("Fetch result for 'doc_3':", fetchResult2["doc_3"]);


// --- 5. Query the collection ---
let queryResults: ZVecDoc[];

// --- 5.1 Vector query ---
queryResults = collection.query({
    fieldName: "imageVector",
    topk: 3,
    vector: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]),
});
console.log("\nTop 3 similar products based on imageVector query:");
console.log(queryResults)

// --- 5.2 Filter query ---
queryResults = collection.query({
    topk: 3,
    filter: "price > 800"
});
console.log("\nProducts whose prices are higher than 800");
console.log(queryResults)

// --- 5.3 Vector + Filter query ---
queryResults = collection.query({
    fieldName: "imageVector",
    topk: 1,
    vector: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]),
    filter: "price > 800"
});
console.log("\nTop 1 product based on imageVector query and whose price is higher than 800");
console.log(queryResults)
// --- 5. Optimize the collection ---
// This function optimizes the collection's internal structures for better performance.
const optimizeResult = collection.optimize();
console.log("\nOptimize result: ", optimizeResult);


// --- 6. Destroy the collection ---
// This function permanently delete the collection from disk.
const destroyResult = collection.destroy();
console.log("\nDestroy result: ", destroyResult);

```
