export const GRAPHQL_PORT = 10102;
export const GRAPHQL_PATH = '/graphql';
export const GRAPHQL_SUBSCRIPTION_PORT = 10103;
export const GRAPHQL_SUBSCRIPTION_PATH = '/subscriptions';

export const todoItemsRxSchema = {
    title: 'todoitems schema',
    description: 'RxSchema for todo list items',
    version: 0,
    type: 'object',
    properties: {
        id: {
            type: 'string',
            primary: true,
        },
        title: {
            type: 'string',
        },
        completed: {
            type: 'boolean',
        },
        updatedAt: {
            type: 'number',
        },
    },
    required: ['title', 'completed'],
};

export const graphQLGenerationInput = {
    todo: {
        schema: todoItemsRxSchema,
        feedKeys: [
            'id',
            'updatedAt'
        ],
        deletedFlag: 'deleted'
    }
};
