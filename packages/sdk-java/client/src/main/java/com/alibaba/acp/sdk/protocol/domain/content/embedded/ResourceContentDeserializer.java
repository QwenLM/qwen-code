package com.alibaba.acp.sdk.protocol.domain.content.embedded;

import com.alibaba.fastjson2.JSONObject;
import com.alibaba.fastjson2.JSONReader;
import com.alibaba.fastjson2.reader.ObjectReader;

import java.lang.reflect.Type;

public class ResourceContentDeserializer implements ObjectReader<ResourceContent> {
    @Override
    public ResourceContent readObject(JSONReader jsonReader, Type fieldType, Object fieldName, long features) {
        if (jsonReader == null || jsonReader.nextIfNull()) {
            return null;
        }
        JSONObject jsonObject = jsonReader.readJSONObject();
        if (jsonObject.containsKey("blob")) {
            return jsonObject.to(BlobResourceContents.class);
        } else if (jsonObject.containsKey("text")) {
            return jsonObject.to(TextResourceContents.class);
        } else {
            return jsonObject.to(ResourceContent.class);
        }
    }
}
