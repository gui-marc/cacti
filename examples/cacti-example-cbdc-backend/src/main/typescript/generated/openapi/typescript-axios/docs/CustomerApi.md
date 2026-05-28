# CustomerApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getBalance**](#getbalance) | **GET** /balance | |
|[**getMe**](#getme) | **GET** /me | |

# **getBalance**
> BalanceResponse getBalance()


### Example

```typescript
import {
    CustomerApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new CustomerApi(configuration);

let chain: ChainCode; // (default to undefined)

const { status, data } = await apiInstance.getBalance(
    chain
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **chain** | **ChainCode** |  | defaults to undefined|


### Return type

**BalanceResponse**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Balance |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getMe**
> MeResponse getMe()


### Example

```typescript
import {
    CustomerApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new CustomerApi(configuration);

const { status, data } = await apiInstance.getMe();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**MeResponse**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Current customer |  -  |
|**401** | Not authenticated |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

