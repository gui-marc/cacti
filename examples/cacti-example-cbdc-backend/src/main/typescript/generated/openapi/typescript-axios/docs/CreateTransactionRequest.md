# CreateTransactionRequest


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**sourceChain** | [**ChainCode**](ChainCode.md) |  | [default to undefined]
**destinationChain** | [**ChainCode**](ChainCode.md) |  | [default to undefined]
**receiverAddress** | **string** |  | [default to undefined]
**amount** | **number** |  | [default to undefined]
**complianceProviders** | **Array&lt;string&gt;** |  | [optional] [default to undefined]
**timeToExpireSeconds** | **number** |  | [optional] [default to undefined]

## Example

```typescript
import { CreateTransactionRequest } from './api';

const instance: CreateTransactionRequest = {
    sourceChain,
    destinationChain,
    receiverAddress,
    amount,
    complianceProviders,
    timeToExpireSeconds,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
