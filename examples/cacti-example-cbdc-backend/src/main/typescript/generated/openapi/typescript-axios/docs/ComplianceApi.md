# ComplianceApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**complianceCheck**](#compliancecheck) | **POST** /compliance/check | |

# **complianceCheck**
> object complianceCheck(body)

Signed-envelope endpoint called by a CBDC controller

### Example

```typescript
import {
    ComplianceApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new ComplianceApi(configuration);

let body: object; //

const { status, data } = await apiInstance.complianceCheck(
    body
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **body** | **object**|  | |


### Return type

**object**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Signed envelope response |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

