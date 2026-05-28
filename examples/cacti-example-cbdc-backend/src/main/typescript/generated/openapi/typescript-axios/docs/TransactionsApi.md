# TransactionsApi

All URIs are relative to *http://localhost*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**acceptTransaction**](#accepttransaction) | **POST** /transactions/{id}/accept | |
|[**createTransaction**](#createtransaction) | **POST** /transactions | |
|[**listTransactions**](#listtransactions) | **GET** /transactions | |

# **acceptTransaction**
> PartnerTransaction acceptTransaction()


### Example

```typescript
import {
    TransactionsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new TransactionsApi(configuration);

let id: string; // (default to undefined)

const { status, data } = await apiInstance.acceptTransaction(
    id
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **id** | [**string**] |  | defaults to undefined|


### Return type

**PartnerTransaction**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Accepted |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **createTransaction**
> PartnerTransaction createTransaction(createTransactionRequest)


### Example

```typescript
import {
    TransactionsApi,
    Configuration,
    CreateTransactionRequest
} from './api';

const configuration = new Configuration();
const apiInstance = new TransactionsApi(configuration);

let createTransactionRequest: CreateTransactionRequest; //

const { status, data } = await apiInstance.createTransaction(
    createTransactionRequest
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **createTransactionRequest** | **CreateTransactionRequest**|  | |


### Return type

**PartnerTransaction**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: application/json
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**201** | Transaction submitted |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **listTransactions**
> Array<PartnerTransaction> listTransactions()


### Example

```typescript
import {
    TransactionsApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new TransactionsApi(configuration);

const { status, data } = await apiInstance.listTransactions();
```

### Parameters
This endpoint does not have any parameters.


### Return type

**Array<PartnerTransaction>**

### Authorization

No authorization required

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Transactions for current customer |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

