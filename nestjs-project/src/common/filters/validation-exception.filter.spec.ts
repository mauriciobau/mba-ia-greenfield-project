import { BadRequestException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { ValidationExceptionFilter } from './validation-exception.filter';

describe('ValidationExceptionFilter', () => {
  let filter: ValidationExceptionFilter;
  let mockJson: jest.Mock<void, [unknown]>;
  let mockStatus: jest.Mock<{ json: jest.Mock<void, [unknown]> }, [number]>;
  let mockHost: ArgumentsHost;

  beforeEach(() => {
    filter = new ValidationExceptionFilter();
    mockJson = jest.fn<void, [unknown]>();
    mockStatus = jest
      .fn<{ json: jest.Mock<void, [unknown]> }, [number]>()
      .mockReturnValue({ json: mockJson });

    mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({ url: '/test', method: 'POST' }),
      }),
      getArgs: () => [],
      getArgByIndex: () => null,
      switchToRpc: () => {
        throw new Error('RPC context is not used by this filter test');
      },
      switchToWs: () => {
        throw new Error('WebSocket context is not used by this filter test');
      },
      getType: () => 'http',
    } as unknown as ArgumentsHost;
  });

  it('normalizes array of class-validator messages', () => {
    const exception = new BadRequestException({
      message: [
        'email must be an email',
        'password must be longer than or equal to 8 characters',
      ],
      error: 'Bad Request',
      statusCode: 400,
    });

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: [
        'email must be an email',
        'password must be longer than or equal to 8 characters',
      ],
    });
  });

  it('wraps single string message into array', () => {
    const exception = new BadRequestException({
      message: 'Invalid input',
      error: 'Bad Request',
      statusCode: 400,
    });

    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(400);
    expect(mockJson).toHaveBeenCalledWith({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: ['Invalid input'],
    });
  });
});
